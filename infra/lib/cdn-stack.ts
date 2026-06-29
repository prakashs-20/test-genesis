import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import type { ComputeStack } from "./compute-stack.js";

export class CDNStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    compute: ComputeStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: "axiralabs.ai",
    });
    const certificate = new acm.Certificate(this, "CdnCert", {
      domainName: config.domainName,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      domainNames: [config.domainName],
      certificate,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(compute.alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
      additionalBehaviors: {
        "/v1/*": {
          origin: new origins.LoadBalancerV2Origin(compute.alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        "/agui/*": {
          origin: new origins.LoadBalancerV2Origin(compute.alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        },
        "/_next/static/*": {
          origin: new origins.LoadBalancerV2Origin(compute.alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: new cloudfront.CachePolicy(this, "StaticCachePolicy", {
            defaultTtl: cdk.Duration.days(30),
            maxTtl: cdk.Duration.days(365),
            minTtl: cdk.Duration.days(1),
          }),
        },
      },
    });

    // DNS record
    new route53.ARecord(this, "DnsRecord", {
      zone: hostedZone,
      recordName: config.domainName,
      target: route53.RecordTarget.fromAlias(
        new targets.CloudFrontTarget(this.distribution),
      ),
    });
  }
}
