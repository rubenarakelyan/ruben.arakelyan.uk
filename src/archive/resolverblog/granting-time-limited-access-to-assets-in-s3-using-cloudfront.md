---
layout: md
title: "Granting time-limited access to assets in S3 using CloudFront"
---

There was a time when asset storage was one of the problems facing web app developers - maybe you stored assets on the web server (easy if you only have one, more difficult if you need to sync them up between multiple servers), or maybe you had a shared disk mounted using NFS. In any case, the easier part was granting access to these assets to the right users. Given that assets are normally stored outside the web server's root directory, it's easy to write a script that checks user access then serves the asset.

The downside of serving your own assets is firstly that you need somewhere to store them (and hopefully back them up) and secondly that it uses up your precious bandwidth (an issue if you pay for a limited amount of bandwidth per month, for example). However, there is a better way - using a cloud storage solution like S3 from AWS.

S3 allows you to store and serve assets quickly, easily and most of all, very cheaply, especially if you basically outsource the serving directly to S3 and bypass your web server entirely. The downside to this is that you lose control of any app-based access controls.

## Why S3 pre-signed URLs don't work here

The simplest answer here is to make use of S3 pre-signed URLs. These are time-limited URLs containing a signing key that is generated from a set of metadata and AWS credentials. If you're using the default S3 URLs, then this is a simple and viable strategy to grant time-limited access to assets in an S3 bucket that are normally only accessible to the owner of the bucket.

In this case however, the objective is to use CloudFront to sit in front of S3 both for CDN and caching purposes, and also because it allows use of a custom domain name to access the assets, as well as allowing much more control of things like HTTP headers.

The problem stems from the fact that CloudFront itself needs to be able to access S3. Once this access is granted, then there is no way for S3 to determine whether the end user accessing the asset via CloudFront is authorised or not - from its point-of-view, all requests originate with CloudFront.

## Enter CloudFront signed URLs

Happily, CloudFront has its own implementation of signed URLs. These are signed at the CloudFront level and can be used to grant time-limited access to any CloudFront-fronted content, not just assets in an S3 bucket.

In our case, we'll use CloudFront signed URLs in our Ruby code to implement time-limited access to sensitive data to only those users who are entitled to access it.

## The S3 bucket and pre-requisites

Before we go ahead and create an S3 bucket, we need two pre-requisites. First up, it's a CloudFront origin access identity (OAI).

```ruby
resource "aws_cloudfront_origin_access_identity" "cloudfront_assets_proxy_origin_access_identity" {
  comment = "CloudFront origin access identity for assets"
}
```

The CloudFront OAI is a construct that allows us to grant access to CloudFront to serve files from an S3 bucket. We use it for this next pre-requisite, which is to create a bucket access policy.

```ruby
data "template_file" "assets_bucket_policy_template" {
  template = file("assets_bucket_policy.json")

  vars = {
    assets_s3_bucket       = "arn:aws:s3:::assets"
    cloudfront_oai_iam_arn = aws_cloudfront_origin_access_identity.cloudfront_assets_proxy_origin_access_identity.iam_arn
  }
}
```

The content of the policy is:

```json
{
  "Version": "2012-10-17",
  "Id": "AssetsBucketPolicy",
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
      ]
    }
  ]
}
```

This policy grants permission to the CloudFront OAI to get objects from the S3 bucket we're about to create. Later when we create the CloudFront distribution, we'll give it this OAI to use akin to an authentication token or IAM role.

Now we're able to create an S3 bucket to hold the assets.

```ruby
resource "aws_s3_bucket" "assets" {
  bucket = "assets"
  policy = data.template_file.assets_bucket_policy_template.rendered

  versioning {
    enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "assets_public_access_block" {
  bucket = aws_s3_bucket.assets.id

  block_public_acls   = true
  block_public_policy = true
}
```

We apply the bucket access policy to our new bucket and enable versioning (optional). We then also block any public permissions from accidentally being applied to the bucket in future as a guard.

## The CloudFront distribution

Next, we need a CloudFront distribution so that we can access the S3 bucket (some details such as TLS certificate setup have been removed for clarity).

```ruby
resource "aws_cloudfront_distribution" "cloudfront_assets_proxy" {
...

  aliases         = ["assets.example.com"]

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "assets-bucket-origin"
    trusted_signers        = ["self"]
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = true

      cookies {
        forward = "none"
      }
    }
  }

  origin {
    domain_name = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id   = "assets-bucket-origin"

    s3_origin_config {
      origin_access_identity = aws_cloudfront_origin_access_identity.cloudfront_assets_proxy_origin_access_identity.cloudfront_access_identity_path
    }
  }

...
}
```

This time, we get to use the dedicated S3 origin type for our distribution.

The important things to note are:

- We only allow `GET` and similar HTTP methods
- We list `self` as a trusted signer (more on this below)
- We set up redirection to HTTPS (the TLS setup has been omitted here)
- We forward all query string values to S3 (more on this below too)
- We configure the S3 origin with the OAI we set up earlier to grant access

## The Route 53 DNS record

As always, we need a DNS record for `[assets.example.com](http://assets.example.com)` that points it to the CloudFront distribution.

```ruby
resource "aws_route53_record" "cloudfront_assets_proxy_service_record" {
  zone_id = "ABC"
  name    = "assets.example.com"
  type    = "CNAME"
  ttl     = 300
  records = [aws_cloudfront_distribution.cloudfront_assets_proxy.domain_name]
}
```

## Using this setup in our app

Now we have all the infrastructure set up, we can start signing URLs in our app.

In this case, we're using Rails' built-in ActiveStorage component with the S3 configuration to handle the uploading and management of files, and the `cloudfront-signer` gem to provide methods for signing our URLs. We enabled `self` to generate signed URLs above, which means anything running under the context of the same AWS account.

We use the root account for AWS to generate a CloudFront public/private key pair which we set up using an environment variable called `CLOUDFRONT_PRIVATE_KEY`.

We then start by configuring the gem with a new initialiser in `config/initializers`:

```ruby
Aws::CF::Signer.configure do |config|
  config.key = ENV["CLOUDFRONT_PRIVATE_KEY"]
  config.key_pair_id = "ID HERE"
  config.default_expires = 3600
end
```

We provide the private key from the key pair and the ID which can be obtained when generating the key pair.

We then define a method that takes a given ActiveStorage file and generates a signed URL for it:

```ruby
def signed_attachment_url(blob)
  filename = blob.filename.sanitized
  key = blob.key
  content_type = blob.content_type

  # Every component of the URL must be URL encoded otherwise signed URLs will not work
  Aws::CF::Signer.sign_url("https://assets.example.com/#{key}?response-content-disposition=inline%3B%20filename%3D%22#{filename}%22&response-content-type=#{content_type}")
end
```

The method takes an ActiveStorage blob (which represents a file in S3) and constructs a URL for it using the domain we set up as a CloudFront distribution, the key (which is the name the file is stored under in S3) and a couple of query string entries which define the original file name and content type (this is why we enabled query string forwarding above).

The given content type is returned by S3 as an HTTP header with the file to allow the browser to determine how to display the file. The file name is also returned as an HTTP header so if the user decides to download or save the file, it'll get a usable file name rather than a random key.

Note as per the comment that you must ensure the entire URL is URL encoded wherever needed as otherwise, the signed URL will not match and no content will be returned.

We can now call this method throughout our application to get a time-limited URL that we can present to users.
