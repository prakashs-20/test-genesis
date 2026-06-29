import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import type { NetworkStack } from "./network-stack.js";

interface TenantDevStackProps extends cdk.StackProps {
  tenantId: string;
  tenantSlug: string;
  hostingModel: "dedicated" | "shared" | "sandbox";
  network: NetworkStack;
}

/**
 * Per-Tenant DEV Environment CDK Stack
 *
 * - Dedicated: 4 small ECS services, shared DB (dev schema), shared Redis
 * - Shared: multi-tenant with RLS isolation
 * - Sandbox: minimal, 100 LLM calls/day, 30-day expiry
 */
export class TenantDevStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TenantDevStackProps) {
    super(scope, id, props);

    const { tenantId, tenantSlug, hostingModel, network } = props;

    if (hostingModel === "sandbox") {
      // Sandbox: minimal single-service deployment
      this.createSandboxService(tenantId, tenantSlug, network);
      return;
    }

    // Dedicated or Shared: 4 small ECS services
    const cluster = new ecs.Cluster(this, "DevCluster", {
      clusterName: `axira-dev-${tenantSlug}`,
      vpc: network.vpc,
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DevNamespace",
      {
        name: `dev.${tenantSlug}.axiralabs.internal`,
        vpc: network.vpc,
      },
    );

    // Smaller sizing for DEV
    const devServices = [
      { name: "axira-gateway", cpu: 256, memory: 512, port: 3001 },
      { name: "axira-workflow-engine", cpu: 256, memory: 512, port: 3002 },
      { name: "axira-agent-runtime", cpu: 512, memory: 1024, port: 3003 },
      { name: "axira-experience", cpu: 256, memory: 512, port: 3000 },
    ];

    // ALB with WebSocket support (for axira dev file sync)
    const alb = new elbv2.ApplicationLoadBalancer(this, "DevAlb", {
      loadBalancerName: `axira-dev-${tenantSlug}`,
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSecurityGroup,
    });

    const listener = alb.addListener("Http", {
      port: 80,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: "Not Found",
      }),
    });

    for (const svc of devServices) {
      const taskDef = new ecs.FargateTaskDefinition(this, `${svc.name}-task`, {
        cpu: svc.cpu,
        memoryLimitMiB: svc.memory,
      });

      taskDef.addContainer("app", {
        image: ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(
            this,
            `${svc.name}-repo`,
            `axira/${svc.name}`,
          ),
          "latest",
        ),
        environment: {
          NODE_ENV: "development",
          AXIRA_ENV: "dev",
          ENVIRONMENT: "dev",
          TENANT_ID: tenantId,
        },
        portMappings: [{ containerPort: svc.port, protocol: ecs.Protocol.TCP }],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `dev-${tenantSlug}-${svc.name}`,
          logRetention: logs.RetentionDays.FOURTEEN_DAYS,
        }),
      });

      const service = new ecs.FargateService(this, `${svc.name}-service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        securityGroups: [network.ecsSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cloudMapOptions: {
          name: svc.name,
          dnsRecordType: servicediscovery.DnsRecordType.A,
          cloudMapNamespace: namespace,
        },
      });

      if (svc.name === "axira-gateway" || svc.name === "axira-experience") {
        const tg = new elbv2.ApplicationTargetGroup(this, `${svc.name}-tg`, {
          vpc: network.vpc,
          port: svc.port,
          protocol: elbv2.ApplicationProtocol.HTTP,
          targets: [service],
          healthCheck: { path: "/v1/health" },
        });

        const pathPatterns =
          svc.name === "axira-gateway" ? ["/v1/*", "/agui/*"] : ["/*"];
        const priority = svc.name === "axira-gateway" ? 10 : 100;

        listener.addTargetGroups(`${svc.name}-rule`, {
          targetGroups: [tg],
          priority,
          conditions: [elbv2.ListenerCondition.pathPatterns(pathPatterns)],
        });
      }
    }

    // DNS: dev.{tenantSlug}.axiralabs.ai
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: "axiralabs.ai",
    });
    new route53.ARecord(this, "DevDns", {
      zone: hostedZone,
      recordName: `dev.${tenantSlug}`,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(alb),
      ),
    });
  }

  private createSandboxService(
    tenantId: string,
    tenantSlug: string,
    network: NetworkStack,
  ) {
    const cluster = new ecs.Cluster(this, "SandboxCluster", {
      clusterName: `axira-sandbox-${tenantSlug}`,
      vpc: network.vpc,
    });

    // Sandbox: minimal combined service (0.5 vCPU, 1GB)
    const taskDef = new ecs.FargateTaskDefinition(this, "SandboxTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer("app", {
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(
          this,
          "gateway-repo",
          "axira/axira-gateway",
        ),
        "latest",
      ),
      environment: {
        AXIRA_ENV: "sandbox",
        TENANT_ID: tenantId,
        LLM_DAILY_LIMIT: "100",
        SANDBOX_EXPIRY_DAYS: "30",
      },
      portMappings: [{ containerPort: 3001, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `sandbox-${tenantSlug}`,
        logRetention: logs.RetentionDays.SEVEN_DAYS,
      }),
    });

    new ecs.FargateService(this, "SandboxService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      securityGroups: [network.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
  }
}
