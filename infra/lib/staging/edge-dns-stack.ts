// Route 53 ALIAS records and the regional WAFv2 WebACL associated to the ALB.

import * as cdk from "aws-cdk-lib";
import {
  CfnOutput,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_elasticloadbalancingv2 as elbv2,
  aws_wafv2 as wafv2,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_certificatemanager as acm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";

export class EdgeDnsStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    hostedZone: route53.IHostedZone,
    alb: elbv2.IApplicationLoadBalancer,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    // vpn private-access (e.g. genesis-prod): Axira does NOT manage the
    // customer's DNS, so write NO Route 53 ALIAS records here. The customer
    // points their own DNS (their Route 53 zone for their domain) at the ALB via
    // the `AlbDnsName` CfnOutput (ComputeStack). The WAF association below STILL
    // runs so the internal ALB keeps its WAF (prod defense-in-depth over VPN).
    const skipDnsRecords =
      envCfg.privateAccess?.enabled && envCfg.privateAccess.mode === "vpn";
    if (!skipDnsRecords) {
      new route53.ARecord(this, "AppRecord", {
        zone: hostedZone,
        recordName: envCfg.domainName,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(alb),
        ),
        comment: `axira ${envCfg.name} app endpoint`,
      });
      new route53.ARecord(this, "ApiRecord", {
        zone: hostedZone,
        recordName: `api.${envCfg.domainName}`,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(alb),
        ),
        comment: `axira ${envCfg.name} api endpoint`,
      });
      new route53.ARecord(this, "DocsRecord", {
        zone: hostedZone,
        recordName: `${envCfg.docs.subdomain}.${envCfg.domainName}`,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(alb),
        ),
        comment: `axira ${envCfg.name} docs endpoint`,
      });
      new route53.ARecord(this, "AdminHubRecord", {
        zone: hostedZone,
        recordName: `admin.${envCfg.domainName}`,
        target: route53.RecordTarget.fromAlias(
          new targets.LoadBalancerTarget(alb),
        ),
        comment: `axira ${envCfg.name} admin-hub endpoint`,
      });
    }

    this.webAcl = this.createWebAcl(envCfg);
    new wafv2.CfnWebACLAssociation(this, "AlbWafAssoc", {
      resourceArn: alb.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });

    new CfnOutput(this, "WebAclArn", { value: this.webAcl.attrArn });

    // ── CloudFront edge in front of the (now origin-locked) ALB ──
    // TLS terminates at CloudFront with the us-east-1 cert; the origin is the
    // ALB over HTTP, and every origin request carries the secret
    // X-Origin-Verify header the WAF requires (createWebAcl). External DNS
    // (Cloudflare) CNAMEs the alias to the distribution domain (output below).
    if (envCfg.cloudFront?.enabled) {
      const cf = envCfg.cloudFront;
      const distribution = new cloudfront.Distribution(this, "Cdn", {
        comment: `axira ${envCfg.name} edge (origin-locked ALB)`,
        domainNames: [...cf.aliases],
        certificate: acm.Certificate.fromCertificateArn(
          this,
          "CdnCert",
          cf.certArn,
        ),
        // Lock the distribution to Cloudflare IPs only (us-east-1 CLOUDFRONT
        // WebACL from EdgeCloudFrontWafStack) so it can't be reached directly,
        // which would bypass Cloudflare Access/WARP. Omitted if no ARN set.
        ...(cf.webAclArn ? { webAclId: cf.webAclArn } : {}),
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        defaultBehavior: {
          origin: new origins.LoadBalancerV2Origin(alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            customHeaders: { "X-Origin-Verify": cf.originVerifySecret },
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          compress: true,
        },
      });
      new CfnOutput(this, "CdnDomainName", {
        value: distribution.distributionDomainName,
        description:
          "Point the external (Cloudflare) DNS CNAME for the alias at this",
      });
    }
  }

  private createWebAcl(envCfg: EnvConfig): wafv2.CfnWebACL {
    const rules: wafv2.CfnWebACL.RuleProperty[] = [];
    let priority = 0;

    if (envCfg.waf.enableAwsCommon) {
      rules.push({
        name: "AwsCommonRules",
        priority: priority++,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: "AWS",
            name: "AWSManagedRulesCommonRuleSet",
            // The Common rule set's `SizeRestrictions_BODY` rule BLOCKs any
            // request body larger than the WAF body-inspection limit (fixed at
            // 8 KB for an ALB — see the note on the WebACL below). The intake
            // document-staging upload (POST .../intake/sessions/:id/stage and
            // the late-doc .../documents/stage) ships the file as base64 JSON,
            // so a typical ~1.5 MB .msg is a ~2 MB body and was 403'd at the
            // ALB edge BEFORE reaching the gateway (rule
            // AWS#AWSManagedRulesCommonRuleSet#SizeRestrictions_BODY). The
            // gateway already caps the body per-route via Fastify `bodyLimit`
            // (MAX_STAGED_FILE_WIRE_BYTES ~134 MB) + a JSON-schema `maximum`,
            // and the route is auth-gated (requirePermission("intake:stage")),
            // so the WAF size rule is redundant for uploads and harmful here.
            // Drop ONLY that sub-rule to Count (every other Common protection —
            // XSS/SQLi/RFI/LFI/bad-bots — stays BLOCK); the first 8 KB of the
            // body is still inspected by those rules.
            ruleActionOverrides: [
              {
                name: "SizeRestrictions_BODY",
                actionToUse: { count: {} },
              },
            ],
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "AwsCommonRules",
          sampledRequestsEnabled: true,
        },
      });
    }
    if (envCfg.waf.enableAwsKnownBadInputs) {
      rules.push({
        name: "AwsKnownBadInputs",
        priority: priority++,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: "AWS",
            name: "AWSManagedRulesKnownBadInputsRuleSet",
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "AwsKnownBadInputs",
          sampledRequestsEnabled: true,
        },
      });
    }
    if (envCfg.waf.enableAnonymousIpBlock) {
      rules.push({
        name: "AwsAnonymousIp",
        priority: priority++,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            vendorName: "AWS",
            name: "AWSManagedRulesAnonymousIpList",
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "AwsAnonymousIp",
          sampledRequestsEnabled: true,
        },
      });
    }

    const docsHost = `${envCfg.docs.subdomain}.${envCfg.domainName}`;
    rules.push({
      name: "RateLimitPerIp",
      priority: priority++,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: envCfg.waf.rateLimitPerIp,
          aggregateKeyType: "IP",
          scopeDownStatement: {
            notStatement: {
              statement: {
                byteMatchStatement: {
                  fieldToMatch: { singleHeader: { name: "host" } },
                  positionalConstraint: "EXACTLY",
                  searchString: docsHost,
                  textTransformations: [{ priority: 0, type: "LOWERCASE" }],
                },
              },
            },
          },
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "RateLimitPerIp",
        sampledRequestsEnabled: true,
      },
    });

    // Origin lock: when CloudFront fronts the ALB, block any request that
    // doesn't carry CloudFront's secret X-Origin-Verify header. The SG already
    // limits ingress to CloudFront IP ranges; this header check ensures it's
    // OURS specifically (the prefix list allows every CloudFront customer).
    // NOTE: searchString is the PLAIN secret here — CfnWebACL/CloudFormation
    // base64-encodes it on the wire (unlike the raw `aws wafv2` CLI, which
    // takes pre-encoded input).
    if (envCfg.cloudFront?.enabled) {
      rules.push({
        name: "BlockNonCloudFront",
        priority: priority++,
        action: { block: {} },
        statement: {
          notStatement: {
            statement: {
              byteMatchStatement: {
                fieldToMatch: { singleHeader: { name: "x-origin-verify" } },
                positionalConstraint: "EXACTLY",
                searchString: envCfg.cloudFront.originVerifySecret,
                textTransformations: [{ priority: 0, type: "NONE" }],
              },
            },
          },
        },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: "BlockNonCloudFront",
          sampledRequestsEnabled: true,
        },
      });
    }

    return new wafv2.CfnWebACL(this, "WebAcl", {
      name: `axira-${envCfg.name}-webacl`,
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      // NOTE: AssociationConfig.requestBody (raising the body-inspection limit
      // above 8 KB) is NOT available for Application Load Balancer — AWS fixes
      // the ALB body-inspection limit at 8 KB. That is exactly why the Common
      // set's SizeRestrictions_BODY rule 403'd the intake-staging uploads, and
      // why the fix is the `count` override on that sub-rule above rather than a
      // larger inspection window. The remaining Common rules still inspect the
      // first 8 KB of every body.
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `axira-${envCfg.name}-webacl`,
        sampledRequestsEnabled: true,
      },
      rules,
    });
  }
}
