---
layout: md
title: "Triggering AWS ECS deployments via GitHub, CodePipeline and ECR"
---

Deployments are a key part of running a web application, but most of the time, they are an afterthought when it comes to process and developer ease-of-use.

However, using a number of AWS services, deployments can be made much easier, with most of the process automated.

On the Accord ODR project, we use ECS to host our application using Docker containers. Here, I’ll show how GitHub, CodePipeline and ECR (Elastic Container Registry) can be used to create an easy-to-use process that mostly just happens in the background and is very light touch.

## Creating a repository for Docker images

We start by creating an ECR repository. This is similar to a Docker Hub repository and is a place to upload built Docker images which can then be pulled as part of the deployment process.

```ruby
resource "aws_ecr_repository" "app_image_repository" {
  name = "app-images"

  image_scanning_configuration {
    scan_on_push = true
  }
}
```

We create a repository called `app-images` which we’ll use in the deployment process. "Scan on push" enables a feature which scans for vulnerabilities in your images which are then displayed in the ECR dashboard.

## CodePipeline and related services

Now we need to set up CodePipeline. But before we create the pipeline itself, we need to create the components that make it up.

In our case, we’ll go with a simple pipeline that is triggered by commits being pushed to the `master` branch, builds a Docker image, runs the test suite, pushes it to ECR then deploys it to ECS.

## Building Docker images with CodeBuild

CodeBuild can be seen as a script-runner - you provide a shell script that is run and provided with a number of environment variables. The script itself can do pretty much anything. In our case, it will receive the contents of the `master` branch, build a Docker image, run the automated test suite, then push the image to the ECR repository we created above, ready for deployment.

```ruby
data "template_file" "codebuild_buildspec" {
  template = file("templates/buildspec.yaml.tpl")

  vars = {
    aws_account_id              = data.aws_caller_identity.current.account_id
    aws_region                  = var.aws_region
    ecr_repository_name         = data.terraform_remote_state.infra_ecr_repositories.outputs.app_image_repository_name
    docker_hub_username         = var.docker_hub_username
    docker_hub_password         = var.docker_hub_password
    build_artifacts_bucket_name = data.terraform_remote_state.infra_build_artifacts_bucket.outputs.build_artifacts_bucket_name
  }
}

resource "aws_codebuild_project" "codebuild" {
  name         = "deployment-codebuild-project"
  service_role = aws_iam_role.codepipeline_role.arn

  artifacts {
    type = "CODEPIPELINE"
  }

  cache {
    type     = "S3"
    location = "${data.terraform_remote_state.infra_build_artifacts_bucket.outputs.build_artifacts_bucket_name}/codebuild-cache"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/build-images:latest"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = data.template_file.codebuild_buildspec.rendered
  }
}
```

Let’s go through what we’ve just created. We start with a build spec file (which we’ll look at next) that will tell CodeBuild what to do. Next, we create the CodeBuild project itself. We define it to be part of a CodePipeline pipeline (this affects how CodeBuild expects to receive artefacts), we provide an S3 bucket where items can be cached temporarily, then we define where our script will run.

In our case, we go with a small general-purpose Linux build machine running a custom-built build image. Our build image is based on the freely-available `docker-dind` image (available from [https://hub.docker.com/_/docker](https://hub.docker.com/_/docker)) with a few more tools added in (notably Docker Compose since that’s what we use to create our images). This is a Docker image that allows us to build more Docker images inside it by including the Docker server.

Finally, we include the build spec file. Let’s take a look at that.

```yaml
version: 0.2

phases:
  pre_build:
    commands:
      - echo Pre-build started on `date`
      - echo Setting environment variables for CodeClimate...
      - export CI_NAME="AWS CodeBuild"
      - export CI_BUILD_ID=$CODEBUILD_BUILD_NUMBER
      - export CI_BUILD_URL="https://${aws_region}.console.aws.amazon.com/codesuite/codebuild/${aws_account_id}/projects/deployment-codebuild-project/build/$CODEBUILD_BUILD_ID"
      - export GIT_BRANCH="master"
      - export GIT_COMMIT_SHA=`git log -1 --pretty=%H`
      - export GIT_COMMITTED_AT=`git log -1 --pretty=format:%ct`
      - export APP_REVISION=`git rev-parse --short HEAD`
      - echo Authenticating with AWS ECR...
      - export ECR_DOMAIN="${aws_account_id}.dkr.ecr.${aws_region}.amazonaws.com"
      - export ECR_REPO="$ECR_DOMAIN/${ecr_repository_name}"
      - export WEB_IMAGE_URI="$ECR_REPO:$GIT_COMMIT_SHA"
      - export WEB_IMAGE_URI_LATEST="$ECR_REPO:latest"
      - aws ecr get-login-password --region ${aws_region} | docker login --username AWS --password-stdin $ECR_DOMAIN
      - echo Authenticating with Docker Hub...
      - docker login --username ${docker_hub_username} --password ${docker_hub_password}
      - echo Running Docker daemon...
      - dockerd &
      - echo Pre-build completed on `date`
  build:
    commands:
      - echo Build started on `date`
      - echo Creating .env file...
      - cp env-example .env
      - echo Building and bringing up Docker containers...
      - app_revision=$APP_REVISION docker-compose -f docker-compose.aws.yml --log-level WARNING up -d
      - echo Running test suite...
      - docker-compose exec -T web .codebuild/run-tests.sh
      - echo Getting taskdef.json files...
      - aws s3api get-object --bucket ${build_artifacts_bucket_name} --key defs/staging/task-definition.json taskdef-staging.json
      - aws s3api get-object --bucket ${build_artifacts_bucket_name} --key defs/production/task-definition.json taskdef-production.json
      - echo Getting appspec.yaml files...
      - aws s3api get-object --bucket ${build_artifacts_bucket_name} --key defs/staging/appspec.yaml appspec-staging.yaml
      - aws s3api get-object --bucket ${build_artifacts_bucket_name} --key defs/production/appspec.yaml appspec-production.yaml
      - echo Pushing "web" image to ECR...
      - docker tag web:latest $WEB_IMAGE_URI
      - docker tag web:latest $WEB_IMAGE_URI_LATEST
      - docker push $ECR_REPO
      - echo Building imageDetail.json...
      - |
        printf "{\"ImageURI\": \"%s\"}" "$WEB_IMAGE_URI" > imageDetail.json
      - echo Build completed on `date`
  post_build:
    commands:
      - echo Post-build started on `date`
      - echo Saving any screenshots to S3...
      - mkdir -p tmp/screenshots
      - docker cp src_web_1:/usr/src/app/tmp/screenshots tmp || true
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
artifacts:
  files:
    - imageDetail.json
    - taskdef-staging.json
    - appspec-staging.yaml
    - taskdef-production.json
    - appspec-production.yaml
```

There’s a lot happening in here, but it can be summarised as follows:

- Set up some environment variables used by CodeClimate (which we’re using here for code coverage reporting)
- Authenticate with ECR and Docker Hub (we’ll use both to pull and push Docker images)
- Run the Docker daemon which we’ll use the build the images
- Create the `.env` file by copying the example
- Use Docker Compose to build the Docker images based on our AWS-specific compose file
- Run the test suite via a script we have in the application repository
- Get some artefact files from S3 (where we’ve uploaded them beforehand)
- Tag and push the "web" Docker image (the one that contains our app) to ECR
- Build an `imageDetail.json` file which will be used by CodeDeploy to deploy the app
- Get any screenshots output by RSpec due to failing tests and make them available for viewing more easily

Most of this shouldn’t be a surprise. Let’s take a look at the artefact files we pull from S3. Firstly, the `appspec.yaml` file:

```yaml
version: 0.0
Resources:
  - TargetService:
      Type: "AWS::ECS::Service"
      Properties:
        TaskDefinition: "<TASK_DEFINITION>"
        LoadBalancerInfo:
          ContainerName: "web"
          ContainerPort: ${app_port}
```

This is a very simple file that defines for ECR which container, port and task definition it should use to run the app. `<TASK_DEFINITION>` is an AWS variable that is filled in automatically during deployment.

Next, the `taskdef.json` file:

```json
{
  "containerDefinitions": [
	  {
	    "environment": [
	      {
	        "name": "AWS_REGION",
	        "value": "${aws_region}"
	      },
	      {
	        "name": "PORT",
	        "value": "${app_port}"
	      },
	      {
	        "name": "RAILS_ENV",
	        "value": "${rails_env}"
	      },
	      {
	        "name": "RAILS_MASTER_KEY",
	        "value": "${rails_master_key}"
	      },
	      {
	        "name": "RAILS_SERVE_STATIC_FILES",
	        "value": "true"
	      },
	      {
	        "name": "RAILS_LOG_TO_STDOUT",
	        "value": "true"
	      },
	      {
	        "name": "DATABASE_URL",
	        "value": "postgresql://${postgresql_username}:${postgresql_password}@${postgresql_host}:5432/${postgresql_db_name}"
	      }
	    ],
	    "essential": true,
	    "image": "${app_image}",
	    "logConfiguration": {
	      "logDriver": "awslogs",
	      "options": {
	        "awslogs-region": "${aws_region}",
	        "awslogs-group": "ecs-logs",
	        "awslogs-stream-prefix": "app-task"
	      }
	    },
	    "mountPoints": [],
	    "name": "web",
	    "portMappings": [
	      {
	        "containerPort": ${app_port},
	        "hostPort": ${app_port},
	        "protocol": "tcp"
	      },
	      {
	        "containerPort": 22,
	        "hostPort": 22,
	        "protocol": "tcp"
	      }
	    ],
	    "volumesFrom": []
	  },
	  {
	    "command": [
	      "bundle", "exec", "sidekiq"
	    ],
	    "environment": [
	      {
	        "name": "AWS_REGION",
	        "value": "${aws_region}"
	      },
	      {
	        "name": "RAILS_ENV",
	        "value": "${rails_env}"
	      },
	      {
	        "name": "RAILS_MASTER_KEY",
	        "value": "${rails_master_key}"
	      },
	      {
	        "name": "DATABASE_URL",
	        "value": "postgresql://${postgresql_username}:${postgresql_password}@${postgresql_host}:5432/${postgresql_db_name}"
	      }
	    ],
	    "essential": true,
	    "image": "${app_image}",
	    "logConfiguration": {
	      "logDriver": "awslogs",
	      "options": {
	        "awslogs-region": "${aws_region}",
	        "awslogs-group": "ecs-logs",
	        "awslogs-stream-prefix": "sidekiq-task"
	      }
	    },
	    "mountPoints": [],
	    "name": "sidekiq",
	    "portMappings": [],
	    "volumesFrom": []
	  }
	],
  "cpu": "${fargate_cpu}",
  "executionRoleArn": "arn:aws:iam::123456789123:role/ecs-task-execution-role",
  "taskRoleArn": "arn:aws:iam::123456789123:role/ecs-task-role",
  "family": "app-task",
  "memory": "${fargate_memory}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": [
    "FARGATE"
  ]
}
```

This is the task definition that ECS will run. It defines everything from the environment variables that will be made available to the Docker container to the resources needed and where logs should be saved.

We generate these files for each environment and save them to an S3 bucket. The CodeBuild project will then retrieve them and pass them onto the next step of the pipeline so they can be used during the deployment process.

## Deploying images with CodeDeploy

Now that we have our application Docker image pushed to ECR, we can deploy it to our environments. This is an example for one environment but multiple CodeDeploy deployment groups can be chained in a pipeline, for example to deploy to staging followed by production.

```ruby
resource "aws_codedeploy_app" "codedeploy" {
  compute_platform = "ECS"
  name             = "codedeploy-app"
}

resource "aws_codedeploy_deployment_group" "codedeploy_deployment_group_production" {
  app_name               = aws_codedeploy_app.codedeploy.name
  deployment_group_name  = "codedeploy-deployment-group-production"
  deployment_config_name = "CodeDeployDefault.ECSAllAtOnce"
  service_role_arn       = aws_iam_role.codepipeline_role.arn

  auto_rollback_configuration {
    enabled = true
    events  = ["DEPLOYMENT_FAILURE"]
  }

  blue_green_deployment_config {
    deployment_ready_option {
      action_on_timeout = "CONTINUE_DEPLOYMENT"
    }

    terminate_blue_instances_on_deployment_success {
      action                           = "TERMINATE"
      termination_wait_time_in_minutes = 60
    }
  }

  deployment_style {
    deployment_option = "WITH_TRAFFIC_CONTROL"
    deployment_type   = "BLUE_GREEN"
  }

  ecs_service {
    cluster_name = "production-app-cluster"
    service_name = "production-app-service"
  }

  load_balancer_info {
    target_group_pair_info {
      prod_traffic_route {
        listener_arns = [data.terraform_remote_state.app_load_balancers_production.outputs.app_https_alb_listener_id]
      }

      target_group {
        name = "production-tg-1"
      }

      target_group {
        name = "production-tg-2"
      }
    }
  }
}
```

Here we create a deployment group which determines how CodeDeploy carries out the deployment and where it deploys to.

We tell CodeDeploy to deploy to all ECS containers at the same time, using a blue-green strategy. This mean that new containers will be created and bought up, then once they are determined to be ready, we have 1 hour to cancel the deployment before the old containers are removed and the newly-deployed ones take their place. During this time, the old containers are drained and all new connections are routed to the new containers.

If there is any failure during the deployment (such as the containers crashing), the deployment is terminated and rolled back to the previous state. In this way, we have zero-downtime deployments and therefore don’t need to schedule them out-of-hours. This strategy is enabled by creating two target groups for our load balancer (one for blue, one for green).

## Bringing it all together with CodePipeline

Now that we have all the pieces, we need to bring them together in a pipeline which we can trigger to carry out the whole process.

```ruby
resource "aws_codepipeline" "codepipeline" {
  name     = "codepipeline-pipeline"
  role_arn = aws_iam_role.codepipeline_role.arn

  artifact_store {
    location = data.terraform_remote_state.infra_build_artifacts_bucket.outputs.build_artifacts_bucket_name
    type     = "S3"
    region   = var.aws_region
  }

  # Get source code pushed to `master` from GitHub
  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      output_artifacts = ["source_output"]

      configuration = {
        # The connection is initially set up via the AWS Management Console
        ConnectionArn        = var.codestar_connection_arn
        FullRepositoryId     = "org/repo"
        BranchName           = "master"
        OutputArtifactFormat = "CODEBUILD_CLONE_REF"
      }
    }
  }

  # Build images, run automated test suite and push to ECR
  stage {
    name = "Build"

    action {
      name             = "Build"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["source_output"]
      output_artifacts = ["build_output"]

      configuration = {
        ProjectName = aws_codebuild_project.codebuild.name
      }
    }
  }

  # Deploy the image to ECS Fargate using a blue/green deployment system (staging)
  stage {
    name = "Deploy_to_Staging"

    action {
      name            = "Deploy"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "CodeDeployToECS"
      version         = "1"
      input_artifacts = ["build_output"]

      configuration = {
        ApplicationName                = aws_codedeploy_app.codedeploy.name
        DeploymentGroupName            = aws_codedeploy_deployment_group.codedeploy_deployment_group_staging.deployment_group_name
        TaskDefinitionTemplateArtifact = "build_output"
        TaskDefinitionTemplatePath     = "taskdef-staging.json"
        AppSpecTemplateArtifact        = "build_output"
        AppSpecTemplatePath            = "appspec-staging.yaml"
      }
    }
  }

  # Manually approve deployment to production
  stage {
    name = "Approve_Deployment_to_Production"

    action {
      name     = "Approve"
      category = "Approval"
      owner    = "AWS"
      provider = "Manual"
      version  = "1"
    }
  }

  # Deploy the image to ECS Fargate using a blue/green deployment system (production)
  stage {
    name = "Deploy_to_Production"

    action {
      name            = "Deploy"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "CodeDeployToECS"
      version         = "1"
      input_artifacts = ["build_output"]

      configuration = {
        ApplicationName                = aws_codedeploy_app.codedeploy.name
        DeploymentGroupName            = aws_codedeploy_deployment_group.codedeploy_deployment_group_production.deployment_group_name
        TaskDefinitionTemplateArtifact = "build_output"
        TaskDefinitionTemplatePath     = "taskdef-production.json"
        AppSpecTemplateArtifact        = "build_output"
        AppSpecTemplatePath            = "appspec-production.yaml"
      }
    }
  }
}
```

Our pipeline starts by connecting to a GitHub repository using a CodeStar connection, which we set up manually beforehand (since it requires authorising AWS to access private GitHub repositories in our case). Any push to the `master` branch triggers the pipeline which gathers a copy of the branch and outputs it for CodeBuild to pick up. CodeBuild runs our previously detailed build spec to build, test and push our Docker image. CodeDeploy then picks this up along with the metadata files and deploys it to ECS in our staging environment.

At this point, we have an approval step that means a developer needs to log in to the AWS Management Console and click a button to either approve or reject the progression of the image to our production environment.

With this, we now have a fully-featured deployment pipeline that needs only light-touch interaction from a developer to deploy all the way to production.

> This blog post was first published on 1 March 2021 at <https://engineering.resolvergroup.com/2021/03/triggering-aws-ecs-deployments-via-github-codepipeline-and-ecr/>.
