---
layout: md
title: "Setting up VPC peering"
---

VPCs are a way of partitioning infrastructure in AWS to isolate them from communication with other infrastructure. They operate at the network level similar to VLANs and block all external communication by default.

However, sometimes it is necessary to allow some inter-VPC communication. For example, if you have multiple AWS accounts that need to access some shared service, that will require infrastructure in one VPC to access infrastructure in another VPC.

On Accord ODR, we want to be able to share anonymised data and statistics with our data team who can analyse it and make it look good for our clients to use. However, they have a separate AWS account containing their data analysis software.

## Connecting VPCs together

To allow the data team’s AWS account to access this data, we needed to set up a peering connection between our VPC and their VPC. However, our main VPC also contains all our other infrastructure which should not be accessible outside the application itself.

To work around this, we set up a separate VPC in our account to hold just a single database that contains the anonymised data. This VPC is peered to our main VPC so an ETL job can regularly take data from our main database, anonymise it and write it to this second database. In turn, this VPC is peered with the data team’s VPC, allowing them to access the database only. This setup works because VPC can have multiple peering connections, and also because peering connections are not transitive - i.e. if VPC A is peered with VPC B and VPC B is peered with VPC C, VPC A and VPC C are not peered with each other, even though they both have a common third peer.

## Peering VPCs in the same account

First, we setup a peering connection between our main VPC and a second VPC which contains the anonymised database:

```ruby
resource "aws_vpc_peering_connection" "vpc_peering_connection" {
  vpc_id      = module.vpc.vpc_id
  peer_vpc_id = module.peered_vpc.vpc_id
  auto_accept = true

  accepter {
    allow_remote_vpc_dns_resolution = true
  }

  requester {
    allow_remote_vpc_dns_resolution = true
  }

  tags = {
    Name        = "production-peering-connection"
    Environment = var.aws_environment
  }
}
```

We have a Terraform module that sets up our VPCs, so we get the ID of the two VPCs to peer. Since they are both in the same account, we can automatically accept the peering connection. We also enable DNS resolution in both directions so that the peer VPC can access resources in the main VPC by DNS name rather than IP address. Note that this enablement must come **after** the peering connection has been set up.

## Peering VPCs in separate accounts

Now that we have a means of accessing our peer VPC, we need to set up a peering connection between that VPC and the data team’s VPC, which is in a separate account (and region).

```ruby
resource "aws_vpc_peering_connection" "vpc_peering_connection_data_team" {
  vpc_id        = module.peered_vpc.vpc_id
  peer_vpc_id   = "vpc-0123456789abcdefg"
  peer_owner_id = "012345678912"
  peer_region   = "eu-west-1"
  auto_accept   = false

  requester {
    allow_remote_vpc_dns_resolution = true
  }

  tags = {
    Name        = "production-peering-connection-data-team"
    Environment = var.aws_environment
  }
}
```

Since we’re now peering with a VPC in a separate account, we need to provide the account ID and region that the peer VPC exists in. We also cannot automatically accept this connection - the owner of the other account need to do that before the connection is live. Finally, we can only enable DNS resolution on our side (requester) - again, the owner of the other account will also need to enable DNS resolution on their side (accepter).

## Setting up routing

We now have peering connections set up, but without routes, there is still no way of directing certain traffic over the peering connection and into the peer VPC. As an example, this is a route set up between our VPC and the data team’s VPC:

```ruby
resource "aws_route" "vpc_peering_data_team_route_requester_private" {
  count = length(module.peered_private_subnet.route_table_ids)

  route_table_id            = module.peered_private_subnet.route_table_ids[count.index]
  destination_cidr_block    = "10.0.0.0/16"
  vpc_peering_connection_id = aws_vpc_peering_connection.vpc_peering_connection_data_team.id
}
```

This route says that any traffic with a destination of `10.0.0.0/16` (the CIDR of the data team’s VPC) should be routed over the peering connection. Again, there will be an equivalent route on the opposite side to route traffic intended for our VPC’s CIDR across the same peering connection.

We now have a fully functioning peering connection which allows the data team to access our anonymised database across the peering connection using a DNS name.

> This blog post was first published on 29 March 2021 at <https://engineering.resolvergroup.com/2021/03/setting-up-vpc-peering/>.
