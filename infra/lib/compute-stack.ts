import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as logs from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import type { NetworkStack } from "./network-stack.js";
import type { DatabaseStack } from "./database-stack.js";
import type { MessagingStack } from "./messaging-stack.js";
import type { TemporalStack } from "./temporal-stack.js";
import type { SecretsStack } from "./secrets-stack.js";
import type { ObservabilityStack } from "./observability-stack.js";

export class ComputeStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly services: Map<string, ecs.FargateService>;
  public readonly alb: elbv2.ApplicationLoadBalancer;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    network: NetworkStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    temporal: TemporalStack,
    observability: ObservabilityStack,
    _secrets: SecretsStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.cluster = new ecs.Cluster(this, "AxiraCluster", {
      clusterName: `axira-${config.env}`,
      vpc: network.vpc,
      containerInsights: true,
    });

    // Service discovery namespace
    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "ServiceNamespace",
      {
        name: `services.${config.env}.axiralabs.internal`,
        vpc: network.vpc,
      },
    );

    // ALB
    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: `axira-${config.env}-alb`,
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: network.albSecurityGroup,
    });

    // ACM certificate
    const hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: "axiralabs.ai",
    });
    const certificate = new acm.Certificate(this, "Cert", {
      domainName: config.domainName,
      subjectAlternativeNames: [
        `*.${config.domainName}`,
        `api.${config.domainName}`,
      ],
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // HTTPS listener
    const httpsListener = this.alb.addListener("Https", {
      port: 443,
      certificates: [certificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: "Not Found",
      }),
    });

    // HTTP -> HTTPS redirect
    this.alb.addListener("Http", {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // Path-based routing for public-facing services
    const routingRules: Array<{
      pathPatterns: string[];
      service: string;
      priority: number;
      port: number;
    }> = [
      {
        pathPatterns: ["/v1/*"],
        service: "axira-gateway",
        priority: 20,
        port: 3001,
      },
      {
        pathPatterns: ["/agui/*", "/v1/agui/*"],
        service: "axira-gateway",
        priority: 10,
        port: 3001,
      },
      {
        pathPatterns: ["/*"],
        service: "axira-experience",
        priority: 100,
        port: 3000,
      },
    ];
    // axira-workflow-engine and axira-agent-runtime are internal services
    // accessed via service discovery, not through the ALB

    this.services = new Map();

    for (const svc of config.compute.services) {
      const taskDef = new ecs.FargateTaskDefinition(this, `${svc.name}-task`, {
        cpu: svc.cpu,
        memoryLimitMiB: svc.memory,
        family: `axira-${config.env}-${svc.name}`,
      });

      const containerPort = svc.name === "axira-experience" ? 3000 : 3001;

      // OTEL_SERVICE_NAME is the canonical short identifier (gateway,
      // workflow-engine, agent-runtime, experience) - strip the
      // `axira-` ECS-naming prefix so traces/logs surface under the
      // service identity used in dashboards + FR-ARCH-22.
      const otelServiceName = svc.name.replace(/^axira-/, "");

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
          NODE_ENV: config.env,
          AXIRA_ENV: config.env,
          TEMPORAL_ADDRESS: temporal.temporalEndpoint,
          REDIS_URL: `redis://${database.redisEndpoint}:6379`,
          OPENSEARCH_URL: `https://${database.opensearchDomain.domainEndpoint}`,
          AXIRA_AGENT_RUNTIME_URL: `http://axira-agent-runtime.services.${config.env}.axiralabs.internal:3003`,
          // Session 2.2 (FR-ARCH-22) - OTel exports go to the customer-
          // cluster ADOT Collector at otel-collector.axira.local:4318.
          // The collector demultiplexes into the axira-logs OpenSearch
          // domain (logs + traces) and the LLM-trace surface (filtered
          // span subset). Direct routing to the LLM-trace surface is
          // intentionally absent from service task defs - that path is
          // collector-owned in deployed environments (ADR 0005). Local
          // dev keeps the direct path alive via
          // packages/observability/src/tracing/setup.ts:68.
          OTEL_EXPORTER_OTLP_ENDPOINT: observability.otelCollectorEndpoint,
          OTEL_LOGS_ENDPOINT: `${observability.otelCollectorEndpoint}/v1/logs`,
          OTEL_SERVICE_NAME: otelServiceName,
          OTEL_RESOURCE_ATTRIBUTES: `service.namespace=axira,deployment.environment=${config.env},cluster.name=${config.env}`,
          // Task 7.9 (E6 retirement) - service-to-service JWT auth. The
          // secret is provisioned via Secrets Manager and wired into the
          // task definition separately from the plain env vars;
          // `SERVICE_AUTH_ENABLED=true` ensures the plugin rejects
          // unauthenticated traffic. Both services read the same secret.
          SERVICE_AUTH_ENABLED: "true",
          SNS_TOPIC_PREFIX: messaging.topicPrefix,
          // SQS queue URLs - only consumed by workflow-engine, but safe to pass to all
          SQS_PROJECTION_QUEUE_URL:
            messaging.queues["projection-consumer"].queueUrl,
          SQS_PROJECTION_PRIORITY_QUEUE_URL:
            messaging.queues["projection-consumer-priority"].queueUrl,
          SQS_SEARCH_INDEX_QUEUE_URL:
            messaging.queues["search-indexer"].queueUrl,
          SQS_NOTIFICATION_QUEUE_URL:
            messaging.queues["notification-dispatcher"].queueUrl,
          SQS_COMPLIANCE_QUEUE_URL:
            messaging.queues["compliance-monitor"].queueUrl,
          SQS_EVENT_SIGNAL_QUEUE_URL:
            messaging.queues["agui-streamer"].queueUrl,
          SQS_WORKFLOW_TRIGGER_QUEUE_URL:
            messaging.queues["workflow-trigger"].queueUrl,
          // DLQ URLs for inspection + replay
          SQS_PROJECTION_DLQ_URL:
            messaging.dlqs["projection-consumer"].queueUrl,
          SQS_PROJECTION_PRIORITY_DLQ_URL:
            messaging.dlqs["projection-consumer-priority"].queueUrl,
          SQS_SEARCH_INDEX_DLQ_URL: messaging.dlqs["search-indexer"].queueUrl,
          SQS_NOTIFICATION_DLQ_URL:
            messaging.dlqs["notification-dispatcher"].queueUrl,
          SQS_COMPLIANCE_DLQ_URL: messaging.dlqs["compliance-monitor"].queueUrl,
          SQS_AGUI_STREAMER_DLQ_URL: messaging.dlqs["agui-streamer"].queueUrl,
          SQS_WEBHOOK_DISPATCHER_DLQ_URL:
            messaging.dlqs["webhook-dispatcher"].queueUrl,
          SQS_WORKFLOW_TRIGGER_DLQ_URL:
            messaging.dlqs["workflow-trigger"].queueUrl,
        },
        secrets: {
          DATABASE_URL: ecs.Secret.fromSecretsManager(database.dbSecret),
        },
        portMappings: [{ containerPort, protocol: ecs.Protocol.TCP }],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: svc.name,
          logRetention: logs.RetentionDays.THIRTY_DAYS,
        }),
        healthCheck: {
          command: [
            "CMD-SHELL",
            `curl -f http://localhost:${containerPort}/v1/health || exit 1`,
          ],
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          retries: 3,
          startPeriod: cdk.Duration.seconds(60),
        },
      });

      const service = new ecs.FargateService(this, `${svc.name}-service`, {
        cluster: this.cluster,
        taskDefinition: taskDef,
        desiredCount: svc.minTasks,
        securityGroups: [network.ecsSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        cloudMapOptions: {
          name: svc.name,
          dnsRecordType: servicediscovery.DnsRecordType.A,
          cloudMapNamespace: namespace,
        },
        circuitBreaker: { rollback: true },
      });

      // Auto-scaling
      const scaling = service.autoScaleTaskCount({
        minCapacity: svc.minTasks,
        maxCapacity: svc.maxTasks,
      });
      scaling.scaleOnCpuUtilization(`${svc.name}-cpu-scaling`, {
        targetUtilizationPercent: 70,
        scaleInCooldown: cdk.Duration.seconds(300),
        scaleOutCooldown: cdk.Duration.seconds(60),
      });

      this.services.set(svc.name, service);
    }

    // Register ALB routing rules for public-facing services
    for (const rule of routingRules) {
      const service = this.services.get(rule.service);
      if (service) {
        const targetGroup = new elbv2.ApplicationTargetGroup(
          this,
          `${rule.service}-tg-${rule.priority}`,
          {
            vpc: network.vpc,
            port: rule.port,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targets: [service],
            healthCheck: {
              path: "/v1/health",
              interval: cdk.Duration.seconds(30),
              healthyThresholdCount: 2,
              unhealthyThresholdCount: 3,
            },
          },
        );

        httpsListener.addTargetGroups(`${rule.service}-rule-${rule.priority}`, {
          targetGroups: [targetGroup],
          priority: rule.priority,
          conditions: [elbv2.ListenerCondition.pathPatterns(rule.pathPatterns)],
        });
      }
    }
  }
}
