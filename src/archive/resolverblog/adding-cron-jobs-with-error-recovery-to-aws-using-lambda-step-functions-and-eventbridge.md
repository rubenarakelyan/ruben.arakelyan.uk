---
layout: md
title: "Adding cron jobs with error recovery to AWS using Lambda, Step Functions and EventBridge"
---

Scheduled jobs (or Cron jobs) are a standard part of web development. Whether you want to update comment counts every night or check for updates once a week, a scheduled job allows you to “set and forget”.

There are a number of methods to implement scheduled jobs. Some rudimentary web apps check the schedule each time someone visits a page. This works as long as there are regular visitors, otherwise the schedule may slip during quiet periods. Better methods include either using the underlying server’s `cron` implementation (if possible) or possibly using a background worker like Sidekiq that also has scheduling capabilities.

If your application is hosted on AWS, there is also another way, using a number of native AWS services chained together to make scheduled calls to endpoints in the application, which can then kick-off jobs.

## Using a Lambda function to call the application

The premise of this setup is that the application has one or more endpoints which, when called, kick off background jobs to carry out a particular task.

We first start be creating a Lambda function that will call the given endpoint(s) when it itself is triggered on a schedule.

```jsx
'use strict';

const https = require('https');

exports.handler = function(event, context, callback) {
  const trigger_urls = [
    'https://webhooks.app/hook1',
    'https://webhooks.app/hook2'
  ];

  for (let url of trigger_urls) {
    const request = https.get(url, (res) => {
      console.log('Successfully requested ' + url);
    });
    request.on('error', (e) => {
      callback('Error requesting ' + url + ': ' + e.message);
    });
  }
};
```

This is a very simple function that just calls a list of URLs one by one.

We could call this function directly from a schedule. However, if there are ever any errors when calling one or more of the URLs, the Lambda function will simply fail and not retry until the next schedule occurs.

A better way of preventing any transient errors is to build in the concept of retries along with exponential backoff, which ensures we don’t swamp the application with multiple requests in a short period of time if the errors continue. Additionally, there should be some way of stopping execution of the function after a number of retries since it’s likely the error is not transient.

We could build these into the Lambda function, but that would be a lot of work and would reinvent a lot of wheels. Instead, we’ll use another AWS service, Step Functions.

## Adding a Step Function to handle errors

Step Functions are normally used to chain together a number of Lambda functions and other AWS services into some kind of workflow. However, the feature we’ll use here is the built in error handling and retry behaviours with our one Lambda function.

```ruby
resource "aws_sfn_state_machine" "background_jobs_step_function" {
  name       = "background_jobs-step-function"
  role_arn   = aws_iam_role.step_function_role.arn
  definition = data.template_file.background_jobs_step_function_definition_template.rendered
} 
```

We then create the definition of the state machine (I’ve skipped the template file where we provide the ARN of the Lambda function to run):

```json
{
  "Version": "1.0",
  "StartAt": "RequestState",
  "States": {
    "RequestState": {
      "Type": "Task",
      "Resource": "${background_jobs_lambda_qualified_arn}",
      "End": true,
      "Retry": [
        {
          "ErrorEquals": ["States.ALL"],
          "IntervalSeconds": 5,
          "BackoffRate": 5,
          "MaxAttempts": 5
        }
      ]
    }
  }
}
```

The definition has one Lambda function to run, and it will attempt to run it up to 5 times, with a 5 second interval between each run, increasing by 5 seconds each time.

Now we have our error handling and retries sorted out, we just need to set up a schedule to run the Step Function.

## Scheduling everything with EventBridge

EventBridge allows us to schedule a service to run in a similar method to a cron job.

```ruby
resource "aws_cloudwatch_event_rule" "event_rule_midnight_daily" {
  name                = "eventbridge-rule-midnight-daily"
  description         = "Runs once a day at 12:05am"
  schedule_expression = "cron(5 0 * * ? *)"
}

resource "aws_cloudwatch_event_target" "background_jobs_step_function_target" {
  rule     = aws_cloudwatch_event_rule.event_rule_midnight_daily.name
  arn      = data.terraform_remote_state.app_step_functions.outputs.background_jobs_step_function_arn
  role_arn = aws_iam_role.eventbridge_role.arn
}
```

There are two parts to setting up a schedule. First, we have the event rule which defines the actual schedule. In this example, we’ll run the Step Function once a day at 12:05 am. Second, we have the event target which defines what EventBridge should run. In this case, we’re providing the ARN of the Step Function we set up earlier.

Bringing it all together, we have a combination of EventBridge, Step Functions and Lambda that will make web hook calls to our application on a schedule and handle errors and retries. This is a great example of how a number of AWS services can be chained together to make something new and better.

> This blog post was first published on 15 February 2021 at <https://engineering.resolvergroup.com/2021/02/adding-cron-jobs-with-error-recovery-to-aws-using-lambda-step-functions-and-eventbridge/>.
