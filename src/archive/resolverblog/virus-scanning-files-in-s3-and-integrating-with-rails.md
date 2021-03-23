---
layout: md
title: "Virus scanning files in S3 and integrating with Rails"
---

If you have an app that accepts file uploads, then either you're aware of the potential risks, or you should be.

With Accord ODR, we started by limiting the types of files that can be uploaded by users. This is the easy part: disallow executable files or anything else that can be scripted. This includes not only obvious candidates like JavaScript files but also things like [WMF images](https://en.wikipedia.org/wiki/Windows_Metafile_vulnerability), since these can contain executable code.

That's all well and good, but file format detection can absolutely be circumvented, and so even when we get an allowed file format uploaded, we have to quarantine it until it's been scanned for viruses, and always assume that the file is infected until it has been proven to be clean.

Of course, virus scanning is not a panacea and files can (and do) get through a scan while also containing a virus. There's always the chance that we'll allow another user to download a file from the site that contains a virus even though our scan has marked it as clean. However, by isolating these files in S3, they at least cannot infect the app itself and potentially obtain access to personal data.

# Using S3 VirusScan

The most popular solution currently available is [Widdix's AWS S3 VirusScan](https://github.com/widdix/aws-s3-virusscan), available from the AWS Marketplace. This is basically a wrapper around ClamAV, an open source virus scanner. The wrapper includes a Lambda function that is triggered each time a file is uploaded to a watched S3 bucket, which then runs ClamAV against the file, and adds metadata to the file to tag its scan result. It also sends a notification to SNS which can be used to trigger other actions (more about that below).

We use Rails' built-in Active Storage to upload files to the watched S3 bucket which then triggers a virus scan.

# Getting virus scan results into your app

Since the virus scanning happens in AWS, the app has no idea of the current scan status of a given uploaded file.

Luckily for us, S3 VirusScan comes with an SNS topic where notifications are posted each time a file is scanned. The notification contains the name of the file and the scanned status (clean or infected).

Using an SNS topic subscription, we can subscribe an endpoint in our app to receive these notifications:

```ruby
resource "aws_sns_topic_subscription" "app_s3_virusscan_subscription" {
  topic_arn              = aws_cloudformation_stack.s3_virusscan.outputs.FindingsTopicArn
  protocol               = "https"
  endpoint               = var.app_s3_virusscan_notification_endpoint
  endpoint_auto_confirms = true
}
```

The `app_s3_virusscan_notification_endpoint` variable is the full URL to an HTTP endpoint that will be called each time a notification is available (for example, https://webhooks.example.com/s3-virusscan).

# Setting up the endpoint controller

At our endpoint, we have a controller than handles incoming SNS notifications. Looking closely, the `endpoint_auto_confirms` flag is set to `true`, and this means that when the subscription is first created, the endpoint must also be able to return a confirmation message, otherwise the subscription will fail.

With that caveat out of the way, let's take a look at our controller:

```ruby
def s3_virus_scan
  head 400 unless subscription_confirmation_message? || notification_message?

  raw_message_body = request.body.read
  message_body = JSON.parse(raw_message_body)
  verify_message_authenticity!(raw_message_body)
  confirm_sns_subscription(message_body) if subscription_confirmation_message?
  update_virus_scan_status_for_blob(message_body) if notification_message?
rescue JSON::ParserError
  head 400
end
```

This is the method that we have linked to our endpoint route and therefore is called for every notification.

Here, we check the notification is either a subscription confirmation or an actual virus scan notification, then we parse the JSON body and either confirm the subscription, or update our own internal state with the virus scan result for the scanned file.

Helpfully for us, SNS notifications are sent with a `X-AMS-SNS-Message-Type` HTTP header that allows us to easily determine what we have:

```ruby
def subscription_confirmation_message?
  request.headers["x-amz-sns-message-type"] == "SubscriptionConfirmation"
end

def notification_message?
  request.headers["x-amz-sns-message-type"] == "Notification"
end
```

With that done, we next need to parse the body to extract the information we need. To make sure we aren't being fooled by someone sending us a fake notification to mark a virus-laden file as clean, we run a method provided by the `aws-sdk-sns` gem which verifies signatures on the notification to make sure it's legitimate:

```ruby
def verify_message_authenticity!(message)
  verifier = Aws::SNS::MessageVerifier.new
  head 401 and return unless verifier.authentic?(message)
end
```

Now that we know we have a legitimate notification, we need to process it. If the notification is a subscription confirmation, it means we're setting up the subscription for the first time. We just need to respond to signal to AWS that the subscription can be set up:

```ruby
def confirm_sns_subscription(message)
  head 400 and return unless message["SubscribeURL"].present?

  # Send an HTTP GET request to the given URL to confirm the subscription
  url = URI.parse(message["SubscribeURL"])
  Net::HTTP.start(url.host, url.port, use_ssl: true) do |http|
    request = Net::HTTP::Get.new(url)
    http.read_timeout = 5
    http.max_retries = 0
    http.request(request)
  end
  render json: { confirmed: true }.to_json, status: 200
rescue Errno::EADDRNOTAVAIL, Net::ReadTimeout
  head 400
end
```

A subscription confirmation comes with a `SubscribeURL` field. We make a request to that URL, which confirms the subscription.

If, on the other hand, the notification is about a virus scan result, then we need to update our records for the given file to mark it as clean or infected:

```ruby
VIRUS_SCAN_STATUS_MAPPING = { "no" => :no_scan, "clean" => :clean, "infected" => :infected }.freeze

def update_virus_scan_status_for_blob(message)
  key = message["MessageAttributes"]["key"]["Value"]
  status = VIRUS_SCAN_STATUS_MAPPING[message["MessageAttributes"]["status"]["Value"]]
  blob = ActiveStorage::Blob.find_by(key: key)
  blob&.update(virus_scan_status: status)
  render json: { key: key, status: status }.to_json, status: 200
end
```

Here, we find the Active Storage blob based on the file name, and we update its virus scan status accordingly.

The `virus_scan_status` attribute for a blob is a custom one added by a simple migration:

```ruby
class AddVirusScanStatusToActiveStorageBlobs < ActiveRecord::Migration[6.0]
  def change
    add_column :active_storage_blobs, :virus_scan_status, :integer, default: 0, null: false
  end
end
```

We then set this field up as an enum on blobs (this is an initialiser that is run when the app starts):

```ruby
module ActiveStorageBlobVirusScanStatus
  extend ActiveSupport::Concern

  included do
    enum virus_scan_status: %i[no_scan clean infected]
  end
end

Rails.configuration.to_prepare do
  ActiveStorage::Blob.include(ActiveStorageBlobVirusScanStatus)
end
```

# "Quarantining" infected files

If the virus scanner marks a file as infected, then we want to make sure that file cannot be downloaded by app users. We could do this by immediately deleting the file, but there is a chance the status is a false positive (all virus scanner vendors sometimes mess up their signature files), or we may be interested in analysing the file further.

For these reasons, we keep infected files in our S3 bucket, but we prevent them from being downloaded using an S3 bucket policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Principal": {
        "AWS": "${cloudfront_oai_iam_arn}"
      },
      "Resource": [
        "${assets_s3_bucket}/*"
      ],
      "Condition": { 
        "StringEquals": {
          "s3:ExistingObjectTag/s3-virusscan": "clean"
        }
      }
    }
  ]
}
```

In a [previous blog post](https://ruben.arakelyan.uk/archive/resolverblog/granting-time-limited-access-to-assets-in-s3-using-cloudfront/), we discussed setting up an S3 bucket policy for our assets bucket (where we store uploaded files) to allow CloudFront to serve these files, authenticating itself with an origin access identity (OAI).

We now add a condition to that policy, which only allows access by CloudFront if the virus scan status of a file is "clean". This means that S3 will deny access to any files that have either not yet been scanned, or have been marked as infected.

This is a nice failsafe to ensure that even if the app attempts to construct a link to such a file and serve it, policy will block that file from actually being served.

# Doing something with the status

Now that everything is set up, every uploaded file starts with a `no_scan` status. Once the file is scanned and we've been notified of the result, we can take various actions.

In our app, we display a message if the file has not yet been scanned or if it has been marked as infected. This gives feedback to the user about the status of their uploads and allows them to take action, for example to re-upload a file or get in touch with us if they suspect a false positive.

# Periodic re-scanning

Right now, this setup scans each file once when it has been first uploaded. This is fine for the majority of cases, but there may be situations where a very new virus which is not yet detectable by virus scanners has infected a file, and that file is marked as clean.

The best way around this issue is to periodically re-scan all the files in our S3 bucket and mark any that are now found to be infected. This could be done, for example, with an EventBridge schedule rule which triggers the virus scanner.

However, the issue with this approach is that as the number of files in the bucket increases, the scan time will also increase, which increases costs in Lambda run time. It also increases costs in repeatedly retrieving files from the bucket and then writing their status metadata back.

This is an area we are still investigating, and hopefully in the future we'll be able to come up with a solution that balances the requirement to detect infected files with the requirement to not add extra unnecessary infrastructure cost.
