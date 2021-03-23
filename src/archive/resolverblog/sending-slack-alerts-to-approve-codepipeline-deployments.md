---
layout: md
title: "Sending Slack alerts to approve CodePipeline deployments"
---

At Resolver, we aim to automate as much of the boring technical jobs as possible, and that includes the whole continuous integration (CI) and deployment pipeline. We trigger these from GitHub, so a mere push or merge can kick-off our automated test suite or deploy to our staging environment for more automated and manual testing.

Our deployment pipeline also happens to deploy the same artefacts that have been deployed to our staging environment to our production environment. The end goal is to be able to do this automatically, but for that to be viable, we need to have 100% trust in our testing strategy, and as with most organisations, we’re not there yet. Therefore, for the time being, we want to be able to pause the pipeline after the staging deployment, and manually approve it to continue to production.

With AWS CodePipeline, this step is easy. The product supports a manual approval stage, and we insert that into our pipleline as follows:

```ruby
stage {
    name = "Approve_Deployment_to_Production"

    action {
      name     = "Approve"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"

      configuration = {
        NotificationArn = aws_sns_topic.codepipeline_manual_approval_alerts_sns_topic.arn
        CustomData      = "Approval needed for production deployment"
      }
    }
  }
```

Most of the stage is pretty basic, but note the configuration block at the bottom. It refers to an SNS topic and a custom string. That’s where our custom alerts come into play.

## Finding out when a deployment is pending

The downside of this automated deployment pipeline is that developers aren’t always aware of what’s happening in the background. One or more deployment may have occurred to the staging environment and may be pending a production deployment. How can we ensure developers are aware of this so deployments don’t get delayed?

This is where SNS comes to the rescue. SNS is a service that receives notifications from various sources and can carry out an action on each receipt. The approval CodePipeline stage supports notifying an SNS topic (a way of separating different notification types and their appropriate actions) each time the stage is triggered. SNS in turn supports triggering a Lambda function each time a notification is received. Putting those features together, we can come up with a solution that posts alerts to a predefined Slack channel each time a production deployment is pending. That way, everyone can see this and act on it.

## Creating a Lambda function

We start by defining a Lambda function that will send a message to a given Slack channel:

```ruby
resource "aws_lambda_function" "send_codepipeline_manual_approval_alerts_to_slack_lambda" {
  filename         = "packages/send_codepipeline_manual_approval_alerts_to_slack.zip"
  function_name    = "codepipeline_to_slack-lambda"
  handler          = "send_codepipeline_manual_approval_alerts_to_slack.handler"
  role             = aws_iam_role.lambda_role.arn
  description      = "Send CodePipeline manual approval alerts to Slack"
  runtime          = "nodejs12.x"
  source_code_hash = filebase64sha256("packages/send_codepipeline_manual_approval_alerts_to_slack.zip")
}
```

This Terraform configuration takes a Lambda function that has been compressed into a Zip file. The Zip file contains a single file with the function, in any of the languages supported by Lambda. Here, we’ve defined NodeJS 12.x as the runtime and our function will be written in JavaScript as a result.

```jsx
'use strict';

var https = require('https');
var util = require('util');

exports.handler = function(event, context) {
  // Log what has been received and decode the JSON message
  console.log('Message received from SNS:', JSON.stringify(event, null, 2));
  var message = JSON.parse(event.Records[0].Sns.Message);

  // Construct message to send to Slack
  var postData = {
    "channel": "#my-slack-channel",
    "username": "CodePipeline",
    "text": "*" + message.approval.customData + "*",
    "icon_emoji": ":aws:"
  };

  postData.attachments = [
    {
      "text": "Please visit " + message.approval.approvalReviewLink + " to approve or reject this deployment."
    }
  ];

  var options = {
    method: 'POST',
    hostname: 'hooks.slack.com',
    port: 443,
    path: '/services/XXX/YYY/ZZZ'
  };

  // Send message to Slack
  var req = https.request(options, function(res) {
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      context.done(null);
    });
  });
  
  req.on('error', function(e) {
    console.log('Problem with request: ' + e.message);
  });    

  req.write(util.format("%j", postData));
  req.end();
};
```

This function takes the message it receives from SNS and extracts some data, which it then assembles into an API call to send to a Slack endpoint URL. To get your unique URL, add a new [incoming webhook](https://api.slack.com/messaging/webhooks) in Slack.

Create this function in a file named the same as the Zip file that you’ll compress it into.

Also, remember to create the Lambda IAM role. This role will allow your Lambda function to log its output to CloudWatch, which is invaluable if it fails!

## Setting up SNS

Now we have our CodePipeline and Lambda function, we need an SNS topic to link them together.

```ruby
resource "aws_sns_topic" "codepipeline_manual_approval_alerts_sns_topic" {
  name                             = "codepipeline-manual-approval-alerts-sns-topic"
  display_name                     = "CodePipeline manual approval alerts"
  lambda_failure_feedback_role_arn = aws_iam_role.sns_role.arn
}

resource "aws_sns_topic_subscription" "codepipeline_manual_approval_alerts_sns_topic_subscription" {
  topic_arn = aws_sns_topic.codepipeline_manual_approval_alerts_sns_topic.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.send_codepipeline_manual_approval_alerts_to_slack_lambda.arn
}

resource "aws_lambda_permission" "slack_alerts_lambda_allow_invocation_from_sns" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.send_codepipeline_manual_approval_alerts_to_slack_lambda.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.codepipeline_manual_approval_alerts_sns_topic.arn
}
```

Here, we create an SNS topic, we link it to the Lambda function using a “subscription”, and we give the Lambda function the permission to be called from the SNS topic.

The SNS role is similar to the Lambda role and just allows it to write logs to CloudWatch.

## Seeing it in action

To test this out, kick-off your CodePipeline and wait for it to reach the manual approval step. If everything’s worked as intended, you should see a message like the one below show up in the Slack channel you defined in the Lambda function earlier:

![A Slack message sent by the Lambda function with a link to approve or reject a production deployment](/img/resolverblog/slack-message.png)

If you don’t see the message above, both Lambda and SNS send their logs to CloudWatch, so check there for any tell-tale failure messages. These are commonly to do with missing permissions or incorrect Slack API configuration.

> This blog post was first published on 28 September 2020 at https://engineering.resolvergroup.com/2020/09/sending-slack-alerts-to-approve-codepipeline-deployments/.
