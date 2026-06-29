import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import type { Environment } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────
// ADOT Collector image tag. Pinned for reproducibility. Bumping this
// is a deliberate change - verify the ADOT release notes for
// pipeline-config compatibility before changing.
//
// public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0 ships:
//   - opensearch exporter with SigV4 auth (us-{east,west}-* regions)
//   - filter processor (OTTL grammar - IsMatch on span.name)
//   - resource / attributes processors
//   - otlphttp exporter (Phoenix path)
//   - batch / health_check / sigv4auth core
// ─────────────────────────────────────────────────────────────────────
const DEFAULT_ADOT_IMAGE_TAG = "v0.40.0";

const DEFAULT_TASK_CPU = 512;
const DEFAULT_TASK_MEMORY_MIB = 1024;
const DEFAULT_DESIRED_COUNT = 2;
const MAX_AUTO_SCALE_COUNT = 10;

const COLLECTOR_SERVICE_NAME = "otel-collector";
const COLLECTOR_NAMESPACE_NAME = "axira.local";
const COLLECTOR_OTLP_HTTP_PORT = 4318;
const COLLECTOR_OTLP_GRPC_PORT = 4317;
const COLLECTOR_HEALTH_PORT = 13133;

export interface OtelCollectorConstructProps {
  /** Customer VPC; collector tasks run in PRIVATE_WITH_EGRESS subnets. */
  readonly vpc: ec2.IVpc;
  /** Shared ECS task SG - collector accepts OTLP from members of this group. */
  readonly ecsSecurityGroup: ec2.ISecurityGroup;
  /** ECS cluster that owns the collector service (created by the caller). */
  readonly cluster: ecs.ICluster;
  /** Cloud Map namespace `axira.local` (created by the caller). */
  readonly cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  /** axira-logs OpenSearch domain - collector SigV4-signs writes against it. */
  readonly logsDomain: opensearch.IDomain;
  /** Environment name from EnvironmentConfig.env. */
  readonly environmentName: Environment;
  /** Cluster.name tag applied to every record by the resource processor. */
  readonly clusterName: string;
  /** Phoenix OTLP HTTP endpoint. Reached only from the collector's traces/llm pipeline. */
  readonly phoenixEndpoint: string;
  /** ADOT image tag override. Defaults to v0.40.0. */
  readonly collectorImageTag?: string;
  readonly desiredCount?: number;
  readonly taskCpu?: number;
  readonly taskMemoryMiB?: number;
}

/**
 * AWS Distro for OpenTelemetry (ADOT) Collector - customer-side ECS
 * Fargate service that demultiplexes OTLP into the three sinks
 * captured by docs/ai-context/reference/observability-architecture.md
 * (Session 2.2):
 *   - axira-logs OpenSearch domain        (logs pipeline)
 *   - axira-logs OpenSearch domain        (traces pipeline)
 *   - Phoenix (LLM-spans only)            (traces/llm pipeline)
 *
 * The pipeline config (infra/lib/observability/otel-collector-config.yaml)
 * is uploaded to SSM Parameter Store at synth time and projected into
 * the container via the `AOT_CONFIG_CONTENT` env var - the ADOT image's
 * documented zero-restart configuration channel. Config changes only
 * require an SSM parameter update + ECS task restart, not a new
 * container image.
 *
 * Service-discovery DNS: `otel-collector.axira.local` resolves to a
 * Cloud Map A record in the namespace passed via props. Services in
 * the same VPC reach the collector through this DNS name with no ALB
 * in the hot path (see ADR - collector is private + stateless).
 */
export class OtelCollectorConstruct extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly logGroup: logs.LogGroup;
  public readonly configParameter: ssm.StringParameter;
  /** Resolved DNS form: `otel-collector.axira.local`. */
  public readonly serviceDiscoveryDns: string;
  /** Full OTLP HTTP base URL the customer-cluster services should point at. */
  public readonly otlpHttpEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    props: OtelCollectorConstructProps,
  ) {
    super(scope, id);

    // ── SSM Parameter: pipeline config ────────────────────────────────
    const configPath = join(__dirname, "otel-collector-config.yaml");
    const configContent = readFileSync(configPath, "utf8");
    this.configParameter = new ssm.StringParameter(this, "Config", {
      parameterName: `/axira/${props.environmentName}/otel-collector/config`,
      stringValue: configContent,
      description:
        "ADOT Collector pipeline configuration (Session 2.2). Sourced from " +
        "infra/lib/observability/otel-collector-config.yaml at synth.",
      tier: ssm.ParameterTier.STANDARD,
    });

    // ── Security group: accepts OTLP from the shared ECS SG ────────────
    // The customer-cluster services already share network.ecsSecurityGroup
    // (network-stack.ts:60). The collector accepts OTLP HTTP (4318) and
    // gRPC (4317) from that group; egress to OpenSearch + Phoenix is
    // allowAllOutbound (collector lives in PRIVATE_WITH_EGRESS subnets).
    this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
      vpc: props.vpc,
      description:
        "ADOT Collector - accepts OTLP from ECS app services on 4317/4318",
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(
      props.ecsSecurityGroup,
      ec2.Port.tcp(COLLECTOR_OTLP_HTTP_PORT),
      "OTLP HTTP from app services",
    );
    this.securityGroup.addIngressRule(
      props.ecsSecurityGroup,
      ec2.Port.tcp(COLLECTOR_OTLP_GRPC_PORT),
      "OTLP gRPC from app services",
    );

    // ── CloudWatch log group for the collector itself ──────────────────
    // 14-day retention matches the log-tier retention in
    // infra/lib/observability/ism/logs-policy.json:1 - keep the
    // collector's own logs visible only as long as the data it
    // processed remains queryable in OpenSearch.
    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/axira/${props.environmentName}/observability/otel-collector`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy:
        props.environmentName === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // ── Fargate task definition ───────────────────────────────────────
    // ARM64 task - ADOT publishes multi-arch images and ARM Fargate is
    // cheaper. 0.5 vCPU / 1 GB matches the resolved sizing in the
    // session contract; auto-scaling expands to 10 tasks before
    // throwing.
    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: props.taskCpu ?? DEFAULT_TASK_CPU,
      memoryLimitMiB: props.taskMemoryMiB ?? DEFAULT_TASK_MEMORY_MIB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      family: `axira-${props.environmentName}-otel-collector`,
    });

    // SSM read for the pipeline config parameter.
    this.configParameter.grantRead(this.taskDefinition.taskRole);
    // SigV4-signed writes to the OpenSearch logs domain. ESHttpPost
    // covers index API and _bulk; ESHttpPut covers index template /
    // policy management (collector should never run those - ObservabilityStack's
    // bootstrap Lambda does - but ESHttpPut is required by the SDK's
    // generic ES action set for some health probes).
    this.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["es:ESHttpPost", "es:ESHttpPut"],
        resources: [`${props.logsDomain.domainArn}/*`],
      }),
    );

    const imageTag = props.collectorImageTag ?? DEFAULT_ADOT_IMAGE_TAG;
    const region = cdk.Stack.of(this).region;

    this.taskDefinition.addContainer("Collector", {
      image: ecs.ContainerImage.fromRegistry(
        `public.ecr.aws/aws-observability/aws-otel-collector:${imageTag}`,
      ),
      environment: {
        AOT_PROFILE: "deployed",
        AWS_REGION: region,
        DEPLOYMENT_ENVIRONMENT: props.environmentName,
        CLUSTER_NAME: props.clusterName,
        LOGS_OPENSEARCH_ENDPOINT: `https://${props.logsDomain.domainEndpoint}`,
        PHOENIX_ENDPOINT: props.phoenixEndpoint,
        PHOENIX_TLS_INSECURE: "false",
      },
      secrets: {
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(this.configParameter),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "collector",
        logGroup: this.logGroup,
      }),
      portMappings: [
        {
          containerPort: COLLECTOR_OTLP_HTTP_PORT,
          protocol: ecs.Protocol.TCP,
        },
        {
          containerPort: COLLECTOR_OTLP_GRPC_PORT,
          protocol: ecs.Protocol.TCP,
        },
        { containerPort: COLLECTOR_HEALTH_PORT, protocol: ecs.Protocol.TCP },
      ],
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -fs http://localhost:${COLLECTOR_HEALTH_PORT}/health || exit 1`,
        ],
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    // ── Fargate service ───────────────────────────────────────────────
    const desiredCount = props.desiredCount ?? DEFAULT_DESIRED_COUNT;
    this.service = new ecs.FargateService(this, "Service", {
      serviceName: `axira-${props.environmentName}-otel-collector`,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount,
      securityGroups: [this.securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      cloudMapOptions: {
        cloudMapNamespace: props.cloudMapNamespace,
        name: COLLECTOR_SERVICE_NAME,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(15),
      },
      enableExecuteCommand: props.environmentName !== "production",
      circuitBreaker: { rollback: true },
    });

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: desiredCount,
      maxCapacity: MAX_AUTO_SCALE_COUNT,
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.minutes(2),
      scaleOutCooldown: cdk.Duration.minutes(1),
    });

    this.serviceDiscoveryDns = `${COLLECTOR_SERVICE_NAME}.${props.cloudMapNamespace.namespaceName}`;
    this.otlpHttpEndpoint = `http://${this.serviceDiscoveryDns}:${COLLECTOR_OTLP_HTTP_PORT}`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Constants re-exported for sibling stacks (ObservabilityStack hands
// these to ComputeStack so the OTEL_* env vars line up).
// ─────────────────────────────────────────────────────────────────────
export const OTEL_COLLECTOR_SERVICE_NAME = COLLECTOR_SERVICE_NAME;
export const OTEL_COLLECTOR_NAMESPACE_NAME = COLLECTOR_NAMESPACE_NAME;
export const OTEL_COLLECTOR_OTLP_HTTP_PORT = COLLECTOR_OTLP_HTTP_PORT;
export const OTEL_COLLECTOR_OTLP_GRPC_PORT = COLLECTOR_OTLP_GRPC_PORT;
export const OTEL_COLLECTOR_HEALTH_PORT = COLLECTOR_HEALTH_PORT;
