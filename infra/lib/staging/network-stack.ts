// VPC, subnets, NAT, gateway and interface VPC endpoints, tiered security groups, and the Cloud Map namespace.

import * as cdk from "aws-cdk-lib";
import {
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_logs as logs,
  aws_servicediscovery as servicediscovery,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly albSg: ec2.SecurityGroup;
  public readonly cloudflaredSg?: ec2.SecurityGroup;
  public readonly serviceSg: ec2.SecurityGroup;
  public readonly dbSg: ec2.SecurityGroup;
  public readonly dbRotationSg: ec2.SecurityGroup;
  public readonly cacheSg: ec2.SecurityGroup;
  public readonly searchSg: ec2.SecurityGroup;
  public readonly serviceDiscoveryNamespace: servicediscovery.PrivateDnsNamespace;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `axira-${envCfg.name}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(envCfg.vpc.cidr),
      maxAzs: envCfg.vpc.azCount,
      natGateways: envCfg.vpc.natGateways,
      subnetConfiguration: [
        { name: "public", cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC },
        {
          name: "private",
          cidrMask: 22,
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          name: "isolated",
          cidrMask: 24,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      flowLogs: {
        rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, "VpcFlowLogs", {
              logGroupName: `/axira/${envCfg.name}/vpc-flow`,
              retention: logs.RetentionDays.ONE_MONTH,
              removalPolicy: RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
    });

    this.albSg = new ec2.SecurityGroup(this, "AlbSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-alb-sg`,
      description: "Public-facing ALB for Axira services",
      allowAllOutbound: true,
    });
    if (envCfg.privateAccess?.enabled && envCfg.privateAccess.mode === "vpn") {
      // Private-access (customer VPN): the ALB is INTERNAL (private IPs only —
      // see ComputeStack) and reachable ONLY over the customer's own VPN. There
      // is no cloudflared connector and no Cloudflare involvement. The SG admits
      // ingress on :80/:443 from the customer-supplied VPN/VPC CIDR(s); without
      // a CIDR the ALB would admit nothing (unreachable), so require at least one.
      const vpnCidrs = envCfg.privateAccess.vpnCidrs ?? [];
      if (vpnCidrs.length === 0) {
        throw new Error(
          `privateAccess.mode='vpn' for ${envCfg.name} requires at least one vpnCidrs entry (the customer VPN/VPC CIDR allowed to the ALB); set CDK_<ENV>_VPN_CIDRS.`,
        );
      }
      for (const cidr of vpnCidrs) {
        this.albSg.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(443),
          `customer VPN to ALB (HTTPS) ${cidr}`,
        );
        this.albSg.addIngressRule(
          ec2.Peer.ipv4(cidr),
          ec2.Port.tcp(80),
          `customer VPN to ALB (HTTP to HTTPS redirect) ${cidr}`,
        );
      }
      // No cloudflaredSg in vpn mode (this.cloudflaredSg stays undefined).
    } else if (envCfg.privateAccess?.enabled) {
      // Private-access (Cloudflare Tunnel + WARP): the ALB has NO public
      // ingress. A cloudflared connector (CloudflaredStack) — attached to this
      // SG — forwards WARP-routed traffic to the ALB's private IPs, so the only
      // thing that may reach the ALB is that connector. The SG is owned here so
      // the ingress rule is intra-stack (no Network→Cloudflared edge), mirroring
      // the dbRotationSg pattern.
      this.cloudflaredSg = new ec2.SecurityGroup(this, "CloudflaredSg", {
        vpc: this.vpc,
        securityGroupName: `axira-${envCfg.name}-cloudflared-sg`,
        description:
          "cloudflared tunnel connector (outbound-only to Cloudflare)",
        allowAllOutbound: true,
      });
      this.albSg.addIngressRule(
        this.cloudflaredSg,
        ec2.Port.tcp(443),
        "cloudflared tunnel to ALB (HTTPS)",
      );
      this.albSg.addIngressRule(
        this.cloudflaredSg,
        ec2.Port.tcp(80),
        "cloudflared tunnel to ALB (HTTP to HTTPS redirect)",
      );
    } else if (envCfg.cloudFront?.enabled) {
      // Behind CloudFront: the ALB is HTTP-only and accepts traffic ONLY from
      // CloudFront's origin-facing IP ranges. Combined with the WAF
      // X-Origin-Verify rule (edge-dns-stack), this seals the ALB so the site
      // is reachable exclusively through our CloudFront distribution.
      this.albSg.addIngressRule(
        ec2.Peer.prefixList(envCfg.cloudFront.originPrefixListId),
        ec2.Port.tcp(80),
        "CloudFront origin-facing only",
      );
    } else {
      this.albSg.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        "HTTP redirect",
      );
      this.albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");
    }

    this.serviceSg = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-service-sg`,
      description: "Axira Fargate services",
      allowAllOutbound: true,
    });
    for (const svc of envCfg.services) {
      this.serviceSg.addIngressRule(
        this.albSg,
        ec2.Port.tcp(svc.containerPort),
        `ALB to ${svc.name}`,
      );
    }
    this.serviceSg.addIngressRule(
      this.serviceSg,
      ec2.Port.tcpRange(3000, 3100),
      "Inter-service traffic",
    );

    this.serviceSg.addIngressRule(
      this.serviceSg,
      ec2.Port.tcp(7233),
      "Temporal gRPC",
    );

    this.dbSg = new ec2.SecurityGroup(this, "DbSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-db-sg`,
      description: "Aurora Postgres (application and Temporal)",
      allowAllOutbound: false,
    });
    this.dbSg.addIngressRule(
      this.serviceSg,
      ec2.Port.tcp(5432),
      "Postgres from services",
    );

    // Owned here (same stack as dbSg) so the ingress rule is intra-stack and
    // does not create a Network→Database cross-stack reference at synth time.
    this.dbRotationSg = new ec2.SecurityGroup(this, "DbRotationSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-db-rotation-sg`,
      description: "Secrets Manager hosted rotation Lambdas",
      allowAllOutbound: true,
    });
    this.dbSg.addIngressRule(
      this.dbRotationSg,
      ec2.Port.tcp(5432),
      "Postgres from rotation lambdas",
    );

    this.cacheSg = new ec2.SecurityGroup(this, "CacheSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-cache-sg`,
      description: "ElastiCache Redis",
      allowAllOutbound: false,
    });
    this.cacheSg.addIngressRule(
      this.serviceSg,
      ec2.Port.tcp(6379),
      "Redis from services",
    );

    this.searchSg = new ec2.SecurityGroup(this, "SearchSg", {
      vpc: this.vpc,
      securityGroupName: `axira-${envCfg.name}-search-sg`,
      description: "OpenSearch",
      allowAllOutbound: false,
    });
    this.searchSg.addIngressRule(
      this.serviceSg,
      ec2.Port.tcp(443),
      "OpenSearch from services",
    );

    this.vpc.addGatewayEndpoint("S3Endpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    this.vpc.addGatewayEndpoint("DynamoEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    const interfaceEndpoints: ReadonlyArray<
      [string, ec2.InterfaceVpcEndpointAwsService]
    > = [
      ["EcrApi", ec2.InterfaceVpcEndpointAwsService.ECR],
      ["EcrDkr", ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ["Logs", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ["Monitoring", ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH],
      ["Secrets", ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      ["Sns", ec2.InterfaceVpcEndpointAwsService.SNS],
      ["Sqs", ec2.InterfaceVpcEndpointAwsService.SQS],
      ["Kms", ec2.InterfaceVpcEndpointAwsService.KMS],
      ["Sts", ec2.InterfaceVpcEndpointAwsService.STS],
      ["Bedrock", ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
    ];
    for (const [name, service] of interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(name, { service, privateDnsEnabled: true });
    }

    this.serviceDiscoveryNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "Internal",
      { name: "axira.internal", vpc: this.vpc },
    );

    new CfnOutput(this, "VpcId", { value: this.vpc.vpcId });
    new CfnOutput(this, "NamespaceName", {
      value: this.serviceDiscoveryNamespace.namespaceName,
    });
  }

  public shared(): SharedProps {
    return {
      vpc: this.vpc,
      albSg: this.albSg,
      cloudflaredSg: this.cloudflaredSg,
      serviceSg: this.serviceSg,
      dbSg: this.dbSg,
      dbRotationSg: this.dbRotationSg,
      cacheSg: this.cacheSg,
      searchSg: this.searchSg,
      serviceDiscoveryNamespace: this.serviceDiscoveryNamespace,
    };
  }
}
