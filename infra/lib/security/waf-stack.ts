import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import type { ComputeStack } from "../compute-stack.js";

export class WafStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    compute: ComputeStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const webAcl = new wafv2.CfnWebACL(this, "AxiraWAF", {
      name: `axira-${config.env}-waf`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `axira-${config.env}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        // Rate limiting: max 2000 requests/5min per IP
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit",
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
        },
        // AWS Managed Rules: Common Rule Set (XSS, SQLi, etc.)
        {
          name: "AWSManagedRulesCommon",
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesCommon",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
        },
        // AWS Managed Rules: Known Bad Inputs
        {
          name: "AWSManagedRulesBadInputs",
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesBadInputs",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
        },
        // Bot control
        {
          name: "BotControl",
          priority: 4,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "BotControl",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesBotControlRuleSet",
            },
          },
        },
        // SQL injection protection
        {
          name: "AWSManagedRulesSQLi",
          priority: 5,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedRulesSQLi",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet",
            },
          },
        },
      ],
    });

    // Associate WAF with ALB
    new wafv2.CfnWebACLAssociation(this, "WafAlbAssociation", {
      resourceArn: compute.alb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
  }
}
