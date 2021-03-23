---
layout: md
title: "Cross-region deployments with CodePipeline"
---

Last time, we looked at [building a deployment pipeline using CodePipeline](/archive/resolverblog/triggering-aws-ecs-deployments-via-github-codepipeline-and-ecr/).

Given the increasing number of countries that are implementing data residency policies, we now need to be able to deploy a copy of our application in a different region along with its database and connected services at the same time as in the main region (London `eu-west-2` in this case).

We’ll look at how we can amend our earlier CodePipeline deployment pipeline to deploy the same application image to ECS in two different regions simultaneously.

## Single region deployment

Last time, our deployment stage for production was the following:

```ruby
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
```

This is a simple deployment action that uses a pre-defined CodeDeploy app and deployment group. These are also described in the previous blog post.

## Cross-region deployment

For a cross-region deployment, we take the above stage as a template and add two extra parameters to end up with:

```ruby
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
      run_order       = 1

      configuration = {
        ApplicationName                = aws_codedeploy_app.codedeploy.name
        DeploymentGroupName            = aws_codedeploy_deployment_group.codedeploy_deployment_group_production.deployment_group_name
        TaskDefinitionTemplateArtifact = "build_output"
        TaskDefinitionTemplatePath     = "taskdef-production.json"
        AppSpecTemplateArtifact        = "build_output"
        AppSpecTemplatePath            = "appspec-production.yaml"
      }
    }

    action {
      name            = "Deploy-Singapore"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "CodeDeployToECS"
      version         = "1"
      input_artifacts = ["build_output"]
      run_order       = 1
      region          = "ap-southeast-1"

      configuration = {
        ApplicationName                = aws_codedeploy_app.codedeploy_sg.name
        DeploymentGroupName            = aws_codedeploy_deployment_group.codedeploy_deployment_group_production_sg.deployment_group_name
        TaskDefinitionTemplateArtifact = "build_output"
        TaskDefinitionTemplatePath     = "taskdef-production-sg.json"
        AppSpecTemplateArtifact        = "build_output"
        AppSpecTemplatePath            = "appspec-production-sg.yaml"
      }
    }
  }
```

Firstly, we now have two actions in the deployment stage. One is our existing action that deploys to `eu-west-2`, and the second is a similar action that deploys to `ap-southeast-1`, as defined by the `region` parameter. It also uses a similar CodeDeploy app and deployment group which point to the ECS infrastructure in `ap-southeast-1`.

Secondly, we add a `run_order` parameter to both actions, and they are both set to `1`. This ensures that both deployment actions run concurrently, rather than the second one waiting for the first one to complete successfully.

Applying this configuration results in the following on the pipeline details page in the AWS Management Console:

![A cross-region deployment action in CodePipeline](/img/resolverblog/cross-region-deployment.png)

We have two parallel actions, with the Singapore one displaying a small double-arrow icon denoting an action that is running in a region different to the one that contains the pipeline itself.

We can add any number of similar parallel actions deploying to different regions at the same time for a truly global application.

> This blog post was first published on 15 March 2021 at https://engineering.resolvergroup.com/2021/03/cross-region-deployments-with-codepipeline/.
