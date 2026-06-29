// CloudFront-scope WAFv2 that locks the CloudFront distribution to Cloudflare
// only — so the distribution can't be hit directly (which would bypass
// Cloudflare Access / WARP). The request path is
//   browser → Cloudflare (Access/WARP) → CloudFront → ALB
// This WebACL makes CloudFront answer ONLY requests whose viewer IP is a
// Cloudflare edge IP; everything else gets the default Block (403).
//
// MUST be deployed in **us-east-1** — CLOUDFRONT-scope WAF resources live
// there. EdgeDnsStack's distribution references this WebACL's ARN via
// `cloudFront.webAclArn` (passed through as a plain ARN, like the cert).

import * as cdk from "aws-cdk-lib";
import { CfnOutput, aws_wafv2 as wafv2 } from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";

// Cloudflare's published origin-facing ranges (https://www.cloudflare.com/ips).
// Refresh occasionally — Cloudflare adds ranges from time to time.
const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

export class EdgeCloudFrontWafStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const v4 = new wafv2.CfnIPSet(this, "CfEdgeV4", {
      name: `axira-${envCfg.name}-cf-edge-v4`,
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV4",
      addresses: CLOUDFLARE_V4,
    });
    const v6 = new wafv2.CfnIPSet(this, "CfEdgeV6", {
      name: `axira-${envCfg.name}-cf-edge-v6`,
      scope: "CLOUDFRONT",
      ipAddressVersion: "IPV6",
      addresses: CLOUDFLARE_V6,
    });

    this.webAcl = new wafv2.CfnWebACL(this, "CfWebAcl", {
      name: `axira-${envCfg.name}-cf-cloudflare-only`,
      scope: "CLOUDFRONT",
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `axira-${envCfg.name}-cf-cloudflare-only`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "AllowCloudflareOnly",
          priority: 0,
          action: { allow: {} },
          statement: {
            orStatement: {
              statements: [
                { ipSetReferenceStatement: { arn: v4.attrArn } },
                { ipSetReferenceStatement: { arn: v6.attrArn } },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AllowCloudflareOnly",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnOutput(this, "CfWebAclArn", {
      value: this.webAcl.attrArn,
      description:
        "Set CDK_GENESIS_STAGING_CF_WEBACL_ARN to this, then deploy edge-dns",
    });
  }
}
