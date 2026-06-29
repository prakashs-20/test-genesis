// Ops plane scaffold: hosted zones for ops/console subdomains. Fleet-sentinel uses Bedrock via the customer task IAM, no separate Anthropic API key needed.

import * as cdk from "aws-cdk-lib";
import { Fn, CfnOutput } from "aws-cdk-lib";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";
import type { EnvConfig } from "./config.js";
import type { SecretsStack } from "./secrets-stack.js";

export class OpsPlaneStack extends cdk.Stack {
  public readonly opsHostedZone: route53.HostedZone;
  public readonly consoleHostedZone: route53.HostedZone;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    _secrets: SecretsStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const opsDomain = `${envCfg.opsPlane.opsSubdomain}.${envCfg.domainName}`;
    const consoleDomain = `${envCfg.opsPlane.consoleSubdomain}.${envCfg.domainName}`;

    this.opsHostedZone = new route53.HostedZone(this, "OpsHostedZone", {
      zoneName: opsDomain,
      comment: `axira ${envCfg.name} ops plane receiver subzone`,
    });

    new CfnOutput(this, "OpsHostedZoneNameServers", {
      value: Fn.join(", ", this.opsHostedZone.hostedZoneNameServers!),
      description: `NS records to add inside ${envCfg.hostedZoneName} for ${opsDomain}`,
      exportName: `axira-${envCfg.name}-ops-ns`,
    });

    this.consoleHostedZone = new route53.HostedZone(this, "ConsoleHostedZone", {
      zoneName: consoleDomain,
      comment: `axira ${envCfg.name} ops console subzone`,
    });

    new CfnOutput(this, "ConsoleHostedZoneNameServers", {
      value: Fn.join(", ", this.consoleHostedZone.hostedZoneNameServers!),
      description: `NS records to add inside ${envCfg.hostedZoneName} for ${consoleDomain}`,
      exportName: `axira-${envCfg.name}-console-ns`,
    });

    new CfnOutput(this, "OpsDomain", { value: opsDomain });
    new CfnOutput(this, "ConsoleDomain", { value: consoleDomain });
  }
}
