---
layout: md
title: "How to redirect an apex domain to www using CloudFront and S3"
---

A common issue for developers and operations staff when it comes to domain names is whether to choose the apex domain (e.g. example.com) or the www subdomain (e.g. www.example.com) as their primary domain, and then how to redirect one to the other.

# Choosing to use www over the apex

At Resolver, we use AWS for the majority of our infrastructure, and we generally have staging and production environments for each product or service we build. We use subdomains as namespaces to separate the environments whilst providing similar URLs for each.

As an example, for a hypothetical product hosted at example.com, the apex domain (example.com) is effectively the namespace for our production environment, whilst the staging subdomain (staging.example.com) is the namespace for our staging environment. Given that we will be using subdomains (such as [app.example.com](http://app.example.com) or [app.staging.example.com](http://app.staging.example.com) for our web app), it makes sense to also have a subdomain for the main site itself, which conveniently can be www (as in [www.example.com](http://www.example.com) or www.staging.example.com).

For the staging environment, this is fine since we don’t expect anyone to be visiting staging.[example.com](http://example.com), but it is a reasonable assumption that some people will try to visit example.com, and without a redirect in place, they’ll be confused about why they can’t access the site.

# Redirecting at the CDN level

By choosing to use the existing CDN to handle the redirect from the apex domain to the www subdomain, we avoid having to deal with this either in our app (slow and extra logic to maintain) or on our web server (extra configuration and bandwidth charges, and not available if you use containerised solutions such as ECS).

This technique requires a CloudFront distribution and an S3 bucket. So let’s see how it’s done.

(As a side note, in this and future technical posts we’ll generally use Terraform’s HCL syntax when we’re demonstrating infrastructure since it allow a concise textual representation).

## The S3 bucket

Firstly, we need an S3 bucket which acts as the origin for the CloudFront distribution. The bucket will be empty but we enable the website hosting feature and configure it to redirect all requests.

```ruby
resource "aws_s3_bucket" "apex_domain_redirect_bucket" {
  bucket = "example.com"
  acl    = "public-read"

  website {
    redirect_all_requests_to = "https://www.example.com"
  }
}
```

The bucket is named after our apex domain, and allows public read (which is necessary for the redirect to work). All requests are redirected to our www subdomain.

## The CloudFront distribution

Next, we need a CloudFront distribution so that we can access the S3 bucket and its redirect from our apex domain (some details such as TLS certificate and caching setup have been removed for clarity).

```ruby
resource "aws_cloudfront_distribution" "apex_domain_redirect_cloudfront_cdn" {
...

  aliases         = ["example.com"]

  default_cache_behavior {

...

    target_origin_id       = "apex-domain-cloudfront-origin"

...

  }

  origin {
    domain_name = aws_s3_bucket.apex_domain_redirect_bucket.website_endpoint
    origin_id   = "apex-domain-cloudfront-origin"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.1"]
    }
  }

...
}
```

Even though there is a dedicated CloudFront origin type for S3 buckets, that is only designed for when you’re serving files from that bucket. Here, we’re using the website hosting capability of S3, which means we need to use the custom origin configuration instead.

We set the origin to the website endpoint of our S3 bucket (which looks something like http://example.com.[s3-website.eu-west-2.amazonaws.com](http://s3-website.eu-west-2.amazonaws.com/)) and we configure it as HTTP-only (S3 website endpoints don’t support HTTPS, but you can terminate TLS in CloudFront by configuring a certificate in the distribution).

At this point, we have our CDN (accessible at something-random.cloudfront.net), which sends all requests to S3, which replies with a redirect to www.example.com.

## The Route 53 DNS record

Finally, we need to add a DNS record for [example.com](http://example.com) that points it to the CloudFront distribution to complete the setup and allow the apex domain to redirect to the www subdomain.

```ruby
resource "aws_route53_record" "apex_domain_redirect_cloudfront_cdn_service_record_ipv4" {
  zone_id = "ABC"
  name    = "example.com"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.apex_domain_redirect_cloudfront_cdn.domain_name
    zone_id                = aws_cloudfront_distribution.apex_domain_redirect_cloudfront_cdn.hosted_zone_id
    evaluate_target_health = false
  }
}
```

Given we’re using both Route 53 and CloudFront, we can make use of alias records. This is useful since ideally we’d use CNAMEs (to allow for changing CloudFront IP addresses without having to update our records), but they are not allowed for apex domains since they cannot co-exist with any other record type (and apex domains have SOA and NS records at a minimum). Alias records are provider-specific records that act like CNAMEs but present themselves as A records pointing to an IP address.

## The final view

Now we have all the puzzle pieces in place, the final user journey looks like this:

Request → Route 53 → CloudFront → S3 → Redirect → CloudFront → User

> This blog post was first published on 8 June 2020 at https://engineering.resolvergroup.com/2020/06/how-to-redirect-an-apex-domain-to-www-using-cloudfront-and-s3/.
