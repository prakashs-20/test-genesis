import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly dbSecurityGroup: ec2.SecurityGroup;
  public readonly cacheSecurityGroup: ec2.SecurityGroup;
  public readonly searchSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly albSecurityGroup: ec2.SecurityGroup;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "AxiraVpc", {
      vpcName: `axira-${config.env}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      maxAzs: config.azCount,
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 20,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // ALB security group -- accepts 80/443 from internet
    this.albSecurityGroup = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      description: "ALB - accepts 80/443 from internet",
      allowAllOutbound: true,
    });
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS",
    );
    this.albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "HTTP redirect",
    );

    // ECS security group -- accepts traffic from ALB
    this.ecsSecurityGroup = new ec2.SecurityGroup(this, "EcsSg", {
      vpc: this.vpc,
      description: "ECS tasks - accepts traffic from ALB and inter-service",
      allowAllOutbound: true,
    });
    this.ecsSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      ec2.Port.tcpRange(3000, 4000),
      "ALB to ECS",
    );
    this.ecsSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcpRange(3000, 4000),
      "ECS inter-service",
    );

    // Database security group -- accepts 5432 from ECS only
    this.dbSecurityGroup = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      description: "RDS - accepts 5432 from ECS only",
      allowAllOutbound: false,
    });
    this.dbSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(5432),
      "ECS to PostgreSQL",
    );

    // Cache security group -- accepts 6379 from ECS only
    this.cacheSecurityGroup = new ec2.SecurityGroup(this, "CacheSg", {
      vpc: this.vpc,
      description: "Redis - accepts 6379 from ECS only",
      allowAllOutbound: false,
    });
    this.cacheSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(6379),
      "ECS to Redis",
    );

    // Search security group -- accepts 9200 from ECS only
    this.searchSecurityGroup = new ec2.SecurityGroup(this, "SearchSg", {
      vpc: this.vpc,
      description: "OpenSearch - accepts 9200 from ECS only",
      allowAllOutbound: false,
    });
    this.searchSecurityGroup.addIngressRule(
      this.ecsSecurityGroup,
      ec2.Port.tcp(9200),
      "ECS to OpenSearch",
    );
  }
}
