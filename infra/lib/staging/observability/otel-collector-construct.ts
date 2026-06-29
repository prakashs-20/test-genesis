// ADOT Collector Fargate construct: OTLP receivers, OpenSearch + Phoenix exporters, Cloud Map registration.

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
import { isProdEnv } from "../config.js";
import type { EnvName } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  readonly vpc: ec2.IVpc;
  readonly ecsSecurityGroup: ec2.ISecurityGroup;
  readonly cluster: ecs.ICluster;
  readonly cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  readonly logsDomain: opensearch.IDomain;
  readonly environmentName: EnvName;
  readonly clusterName: string;
  readonly phoenixEndpoint: string;
  readonly collectorImageTag?: string;
  readonly desiredCount?: number;
  readonly taskCpu?: number;
  readonly taskMemoryMiB?: number;
}

export class OtelCollectorConstruct extends Construct {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly logGroup: logs.LogGroup;
  public readonly configParameter: ssm.StringParameter;
  public readonly serviceDiscoveryDns: string;
  public readonly otlpHttpEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    props: OtelCollectorConstructProps,
  ) {
    super(scope, id);

    const configPath = join(__dirname, "otel-collector-config.yaml");
    const configContent = readFileSync(configPath, "utf8");
    this.configParameter = new ssm.StringParameter(this, "Config", {
      parameterName: `/axira/${props.environmentName}/otel-collector/config`,
      stringValue: configContent,
      description:
        "ADOT Collector pipeline configuration sourced from observability/otel-collector-config.yaml at synth.",
      // ADVANCED tier supports up to 8 KB. The pipeline YAML routinely
      // exceeds the STANDARD 4 KB ceiling once receivers/exporters expand.
      // SSM Advanced costs ~$0.05/month per parameter — negligible vs the
      // failure mode of silently truncating config.
      tier: ssm.ParameterTier.ADVANCED,
    });

    this.securityGroup = new ec2.SecurityGroup(this, "Sg", {
      vpc: props.vpc,
      securityGroupName: `axira-${props.environmentName}-otel-collector-sg`,
      description:
        "ADOT Collector accepts OTLP from ECS app services on 4317 and 4318",
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

    this.logGroup = new logs.LogGroup(this, "LogGroup", {
      logGroupName: `/axira/${props.environmentName}/observability/otel-collector`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProdEnv(props.environmentName)
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: props.taskCpu ?? DEFAULT_TASK_CPU,
      memoryLimitMiB: props.taskMemoryMiB ?? DEFAULT_TASK_MEMORY_MIB,
      runtimePlatform: {
        // Use X86_64 — the public.ecr.aws/aws-observability/aws-otel-collector
        // image does not always publish an arm64 manifest entry, so Fargate
        // Graviton tasks fail to launch with image manifest errors.
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      family: `axira-${props.environmentName}-otel-collector`,
    });

    // ECS pulls `secrets:` block values at container start time using the
    // EXECUTION role, not the task role. The task role only matters for
    // SDK calls the running container makes itself. Grant both so neither
    // path can hit AccessDenied — the executionRole grant is what unblocks
    // ResourceInitializationError on container start.
    this.configParameter.grantRead(this.taskDefinition.taskRole);
    this.configParameter.grantRead(this.taskDefinition.obtainExecutionRole());

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
        { containerPort: COLLECTOR_OTLP_HTTP_PORT, protocol: ecs.Protocol.TCP },
        { containerPort: COLLECTOR_OTLP_GRPC_PORT, protocol: ecs.Protocol.TCP },
        { containerPort: COLLECTOR_HEALTH_PORT, protocol: ecs.Protocol.TCP },
      ],
      // No container healthCheck. The aws-otel-collector image is minimal
      // and does NOT bundle curl/wget, so a `curl localhost:13133/health`
      // check always exits non-zero, marks the task UNHEALTHY, and trips
      // the deployment circuit breaker. Rely on the service's standard
      // ECS task health (running == healthy) — failed collector pods will
      // still be replaced by the scheduler.
    });

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
      enableExecuteCommand: !isProdEnv(props.environmentName),
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
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

export const OTEL_COLLECTOR_SERVICE_NAME = COLLECTOR_SERVICE_NAME;
export const OTEL_COLLECTOR_NAMESPACE_NAME = COLLECTOR_NAMESPACE_NAME;
export const OTEL_COLLECTOR_OTLP_HTTP_PORT = COLLECTOR_OTLP_HTTP_PORT;
export const OTEL_COLLECTOR_OTLP_GRPC_PORT = COLLECTOR_OTLP_GRPC_PORT;
export const OTEL_COLLECTOR_HEALTH_PORT = COLLECTOR_HEALTH_PORT;
