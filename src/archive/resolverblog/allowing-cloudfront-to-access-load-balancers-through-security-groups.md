---
layout: md
title: "Allowing CloudFront to access load balancers through Security Groups"
---

Security Groups are a best practice feature of VPCs in AWS that act similar to a firewall. They allow access to various resources such as EC2 instances, load balancers or RDS databases to be controlled to other resources or a set of IP addresses.

For example, you may set up an EC2 instance to only be accessible by a load balancer. This means uses cannot bypass the load balancer to access your instance directly. You might set this up as follows:

```ruby
resource "aws_security_group" "app" {
  name        = "app-access"
  vpc_id      = data.terraform_remote_state.app_vpc.outputs.vpc_id
  description = "Controls access to the app containers"

  ingress {
    protocol        = "tcp"
    from_port       = 8080
    to_port         = 8080
    security_groups = [aws_security_group.load_balancer.id]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

Here, we set up the Security Group that’s attached to the load balancer to access the application (in this instance, running in ECS). We allow the app containers ingress access only from the load balancer to port 8080 (where the app is running). We also allow the app container all egress access back to the Internet.

This setup works in all instances where you can specify access to a resource using another Security Group, but what if you want to limit access to CloudFront, which doesn’t have a Security Group?

In this case, you would normally fall back to using IP addresses. For example, the following example allows SSH access to a bastion EC2 instance:

```ruby
resource "aws_security_group" "bastion" {
  name        = "bastion-access"
  vpc_id      = data.terraform_remote_state.app_vpc.outputs.vpc_id
  description = "Controls access to the bastion host"

  ingress {
    protocol    = "tcp"
    from_port   = 22
    to_port     = 22
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

Here, we allow access from any IP address to port 22 for SSH, and again we allow all egress access back to the Internet.

The difference with CloudFront is that the IP addresses it uses for ingress access change over time, so we can’t just hardcode a list of them into the configuration. Instead, we need to get the list dynamically whenever we run Terraform, and pass this list to the security group.

```ruby
# Get the current list of AWS CloudFront IP ranges
data "aws_ip_ranges" "cloudfront" {
  services = ["cloudfront"]
}

# Chunk the CloudFront IP ranges into blocks of 30 to get around security group limits
locals {
  cloudfront_ip_ranges_chunks = chunklist(data.aws_ip_ranges.cloudfront.cidr_blocks, 30)
}
```

We use the `aws_ip_ranges` data provider and ask it for the IP addresses currently associated with CloudFront. This will be the correct list for the moment we run Terraform. Before passing this list on to a Security Group, however, we need to split it into chunks of 30 IP addresses. This is because Security Groups have a hard upper limit of 30 IP addresses.

Now we have the IP addresses, we can create a Security Group to grant them access to the load balancer as follows: 

```ruby
resource "aws_security_group" "load_balancer" {
  count = length(local.cloudfront_ip_ranges_chunks)

  name        = "load-balancer-access${count.index == 0 ? "" : count.index + 1}"
  vpc_id      = data.terraform_remote_state.app_vpc.outputs.vpc_id
  description = "Controls access to the ALB"

  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = local.cloudfront_ip_ranges_chunks[count.index]
  }

  ingress {
    protocol    = "tcp"
    from_port   = 8080
    to_port     = 8080
    cidr_blocks = local.cloudfront_ip_ranges_chunks[count.index]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```

Here we create a Security Group per chunk, and feed the chunk into an ingress rule. As of this blog post, this will result in 4 Security Groups being created, each of which allows access from 30 CloudFront IP addresses to the load balancer.

**Please note, however, that CloudFront IP addresses change every now and then. At the moment, there doesn’t seem to be a better way of restricting access than running this configuration every now and then to refresh the list of IP addresses allowed access.**

> This blog post was first published on 1 February 2021 at https://engineering.resolvergroup.com/2021/02/allowing-cloudfront-to-access-load-balancers-through-security-groups/.
