// Shared ECS Fargate cluster used by Temporal and the application services.

import * as cdk from "aws-cdk-lib";
import { CfnOutput, aws_ec2 as ec2, aws_ecs as ecs } from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";

export class ClusterStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    vpc: ec2.IVpc,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      clusterName: `axira-${envCfg.name}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });

    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
  }
}
