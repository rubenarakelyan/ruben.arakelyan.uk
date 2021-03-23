---
layout: md
title: "CI using GitHub and AWS CodeBuild"
---

[Last time](/archive/resolverblog/sending-slack-alerts-to-approve-codepipeline-deployments/), we mentioned CI as one of things that we try to automate as much as possible. This time, we’ll go through more details about our CI setup and how it relates to our deployment pipeline.

## Setting up the CodeBuild project

As well as being used as part of a CodePipeline, CodeBuild can also be used on its own as a script-runner of sorts. This makes it ideal as somewhere to run automated tests, and this is exactly what we do.

```ruby
data "template_file" "codebuild_buildspec" {
  template = file("templates/buildspec.yaml.tpl")

  vars = {
    aws_account_id              = data.aws_caller_identity.current.account_id
    aws_region                  = var.aws_region
    build_artifacts_bucket_name = data.terraform_remote_state.infra_build_artifacts_bucket.outputs.build_artifacts_bucket_name
  }
}

resource "aws_codebuild_project" "codebuild" {
  name         = "ci-codebuild-project"
  service_role = aws_iam_role.codebuild_role.arn

  artifacts {
    type = "NO_ARTIFACTS"
  }

  cache {
    type  = "LOCAL"
    modes = ["LOCAL_DOCKER_LAYER_CACHE"]
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "org/docker-19.03-dind:latest"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  source {
    type            = "GITHUB"
    location        = "https://github.com/org/repo"
    buildspec       = data.template_file.codebuild_buildspec.rendered
  }
}
```

This is a similar setup to our [one-off Fargate containers](/archive/resolverblog/running-database-migrations-on-deployment-for-fargate-containers/) for running database migrations, which also runs in CodeBuild.

We get the CodeBuild spec (which we’ll go into next), and then set up the project. The project setup itself is very simple - we just give CodeBuild our GitHub repository, and tell it to run our project inside the `docker-19.03-dind` Docker container.

The `docker-19.03-dind` Docker container is one we build and run ourselves, and it’s [hosted on Docker Hub](https://hub.docker.com/r/accordodr/docker-19.03-dind) for anyone to use. It’s based on the `docker-19.03-dind` base container, and [we add](https://github.com/resolving/docker-19.03-dind) Docker Compose, Bash, Git and the AWS CLI. This means we can use our Docker Compose setup for CI easily to bring up all the relevant containers. DIND here stands for "Docker in Docker", which means the container itself also runs Docker. This is required for Docker Compose to work.

## The CodeBuild buildspec

Our buildspec is a little complex but does only a few things:

```yaml
version: 0.2

phases:
  pre_build:
    commands:
      - echo Pre-build started on `date`
      - echo Setting environment variables for CodeClimate...
      - export CI_NAME="AWS CodeBuild"
      - export CI_BUILD_ID=$CODEBUILD_BUILD_NUMBER
      - export CI_BUILD_URL="https://${aws_region}.console.aws.amazon.com/codesuite/codebuild/${aws_account_id}/projects/ci-codebuild-project/build/$CODEBUILD_BUILD_ID"
      - export GIT_BRANCH=$CODEBUILD_WEBHOOK_HEAD_REF
      - export GIT_COMMIT_SHA=`git log -1 --pretty=%H`
      - export GIT_COMMITTED_AT=`git log -1 --pretty=format:%ct`
      - echo Running Docker daemon...
      - dockerd &
      - echo Pre-build completed on `date`
  build:
    commands:
      - echo Build started on `date`
      - echo Creating .env file...
      - cp env-example .env
      - echo Building and bringing up Docker containers...
      - docker-compose -f docker-compose.aws.yml --log-level WARNING up -d
      - echo Running test suite...
      - docker-compose exec -T web .codebuild/run-tests.sh
      - echo Build completed on `date`
  post_build:
    commands:
      - echo Post-build started on `date`
      - echo Saving any screenshots to S3...
      - mkdir -p tmp/screenshots
      - docker cp app_web_1:/usr/src/app/tmp/screenshots tmp || true
      - |
        if [ "$(ls -A tmp/screenshots)" ]; then
          aws s3 cp tmp/screenshots s3://${build_artifacts_bucket_name}/screenshots --recursive
          echo The following screenshots of failed tests are available:
          for filename in tmp/screenshots/*.*; do
            basename=`basename $filename`
            echo https://${build_artifacts_bucket_name}.s3.${aws_region}.amazonaws.com/screenshots/$basename
          done
        fi
      - echo Bringing down Docker containers...
      - docker-compose down
      - echo Post-build completed on `date`
```

### Pre-build

The pre-build section sets up some environment variables (some of them by running `git`). These are used by the Code Climate test reporter, which reports things like test coverage on every run to our Code Climate account.

It also starts the Docker daemon in the background.

### Build

We start by setting up the `.env` file from our sample, and then run Docker Compose, which brings up all the containers we need to be able to run the automated test suite.

Finally, we run a script in our app repo named `run-tests.sh` which runs the automated test suite.

### Post-build

Our automated test suite generates screenshots for every failed test, and here we copy those from the temporary test container to an S3 bucket which is then accessible to our developers. We also print out details of this bucket and links to the screenshots to make life easier.

Finally, we tear down all the containers and complete the build.

## The test runner

The `run-tests.sh` file is a simple shell script:

```bash
#!/bin/sh
set -e

# Install and start Code Climate test reporter
wget -q -O cc-test-reporter https://s3.amazonaws.com/codeclimate/test-reporter/test-reporter-latest-linux-amd64
chmod +x cc-test-reporter
./cc-test-reporter before-build

# Create the database and load the schema
bundle exec rake db:create db:schema:load

# Run the test suite
bundle exec rspec

# Report test code coverage to Code Climate
./cc-test-reporter format-coverage -t simplecov -o coverage/codeclimate.json coverage/.resultset.json
./cc-test-reporter upload-coverage
```

Apart from setting up the database and running the test suite, we also set up the Code Climate test reporter, and then upload the test coverage output we get from [simplecov](https://rubygems.org/gems/simplecov). This allows us to track test coverage in our apps over time.

## Integrating with GitHub

Now, none of this is really useful unless we can integrate it with GitHub, our SCM system.

Luckily for us, CodeBuild has a built-in webhook system and it knows how to integrate this with GitHub.

```ruby
resource "aws_codebuild_webhook" "codebuild_webhook" {
  project_name = aws_codebuild_project.codebuild.name

  filter_group {
    filter {
      type    = "EVENT"
      pattern = "PUSH"
    }

    filter {
      type                    = "HEAD_REF"
      pattern                 = "master"
      exclude_matched_pattern = true
    }
  }
}
```

Here, we set up a webhook that is triggered on every push to our repo, apart from pushes to `master`. This means that we can run our deployment pipeline (which also runs our automated test suite) on pushes to `master` without also running this project.

Once the webhook is set up, not only will every push trigger the project, but the results will also be reported back to the commit/PR. Any exit from the buildspec with an error code other than zero will report back a failure. The result also links back to the project output for easier debugging.

> This blog post was first published on 19 October 2020 at https://engineering.resolvergroup.com/2020/10/ci-using-github-and-aws-codebuild/.
