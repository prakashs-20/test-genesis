// cloudflared tunnel connector for the private-access (Cloudflare Tunnel + WARP)
// model. A single ECS Fargate task runs `cloudflared tunnel run`, dials OUT to
// Cloudflare (no inbound ports), and forwards WARP-routed private-network
// traffic to the ALB's private IPs. The request path is:
//   browser (WARP) → Cloudflare → tunnel → cloudflared → ALB :443 → app
//
// The connector's SG (NetworkStack.cloudflaredSg) is the ONLY source the ALB SG
// accepts ingress from, so the ALB has no public surface. The tunnel token is
// read from Secrets Manager (value seeded operationally; only the ARN is in
// config). Enabled per env via `privateAccess.enabled`.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";

export class CloudflaredStack extends cdk.Stack {
  public readonly service: ecs.FargateService;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    shared: SharedProps,
    cluster: ecs.ICluster,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const pa = envCfg.privateAccess;
    if (!pa?.enabled) {
      throw new Error(
        "CloudflaredStack instantiated without privateAccess.enabled",
      );
    }
    if (pa.mode === "vpn") {
      // vpn mode has no cloudflared connector — the customer reaches the ALB
      // over their own VPN. bin/axira-staging.ts must not instantiate this stack
      // for vpn mode; guard here so a wiring mistake fails loudly at synth.
      throw new Error(
        "CloudflaredStack instantiated for privateAccess.mode='vpn' (no connector in vpn mode)",
      );
    }
    if (!pa.tunnelTokenSecretArn) {
      throw new Error(
        "CloudflaredStack requires privateAccess.tunnelTokenSecretArn for cloudflared mode",
      );
    }
    if (!shared.cloudflaredSg) {
      throw new Error(
        "CloudflaredStack requires shared.cloudflaredSg (NetworkStack must run with privateAccess.enabled)",
      );
    }

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/axira/${envCfg.name}/cloudflared`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Import by exact ARN so the ECS `valueFrom` is a concrete secret ARN
    // (fromSecretNameV2 yields a `-??????` wildcard ARN ECS rejects). Granting
    // on the imported reference only mutates this role's policy.
    const tunnelToken = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "TunnelToken",
      pa.tunnelTokenSecretArn,
    );

    const executionRole = new iam.Role(this, "ExecRole", {
      roleName: `axira-${envCfg.name}-cloudflared-exec`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    tunnelToken.grantRead(executionRole);

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      family: `axira-${envCfg.name}-cloudflared`,
      cpu: pa.connectorCpu ?? 256,
      memoryLimitMiB: pa.connectorMemoryMiB ?? 512,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    taskDef.addContainer("cloudflared", {
      image: ecs.ContainerImage.fromRegistry("cloudflare/cloudflared:latest"),
      essential: true,
      // `run` with no tunnel arg uses the token (TUNNEL_TOKEN) to resolve the
      // tunnel + its remote-managed config (warp-routing to the VPC CIDR).
      // --metrics exposes a local readiness/metrics endpoint on :2000.
      command: [
        "tunnel",
        "--no-autoupdate",
        "--metrics",
        "0.0.0.0:2000",
        "run",
      ],
      secrets: {
        // Whole-secret value is the token (no JSON field).
        TUNNEL_TOKEN: ecs.Secret.fromSecretsManager(tunnelToken),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "cloudflared",
        logGroup,
      }),
      stopTimeout: Duration.seconds(30),
      readonlyRootFilesystem: false,
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: taskDef,
      serviceName: `axira-${envCfg.name}-cloudflared`,
      desiredCount: pa.desiredCount ?? 1,
      assignPublicIp: false,
      securityGroups: [shared.cloudflaredSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: !isProdEnv(envCfg.name),
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
    });

    new CfnOutput(this, "CloudflaredService", {
      value: this.service.serviceName,
      description: `cloudflared tunnel connector for ${pa.aliases.join(", ")}`,
    });
  }
}
