// infra/lib/staging/msteams-stack.ts
//
// Microsoft Teams integration — ECS Fargate service for the apps/teams-bot
// Fastify v5 service. Bot Framework webhook + service-token /v1/notify +
// /healthz. Defined here but deployed manually via `cdk deploy
// <prefix>-msteams` only after the operator has:
//
//   1. Built + pushed an apps/teams-bot image to the ECR repo this stack
//      creates.
//   2. Seeded the six per-customer secrets via
//      scripts/msteams/seed-secrets.sh.
//   3. Configured AAD app + Bot Framework registration + Auth0 federation
//      per docs/ai-context/playbooks/msteams-customer-onboarding.md.
//
// Until then, the construct uses a public nginx placeholder image so `cdk
// synth` / `cdk diff` work without a published image.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_servicediscovery as servicediscovery,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";
import type { SecretsStack } from "./secrets-stack.js";

const CONTAINER_PORT = 3030;
const TASK_CPU = 2048; // 2 vCPU
const TASK_MEMORY = 4096; // 4 GB
const SUBDOMAIN = "bot";
const SERVICE_NAME = "axira-teams-bot";

export interface MsteamsStackProps extends cdk.StackProps {
  /**
   * ECS cluster to deploy into. Owned by ClusterStack; passed in by the
   * staging app entrypoint.
   */
  readonly cluster: ecs.ICluster;
  /** ALB to attach the listener rule to. Owned by ComputeStack. */
  readonly alb: elbv2.IApplicationLoadBalancer;
  /** HTTPS listener. Owned by ComputeStack. */
  readonly httpsListener: elbv2.IApplicationListener;
  /**
   * Shared network primitives (VPC, security groups, Cloud Map namespace).
   * Owned by NetworkStack.
   */
  readonly shared: SharedProps;
  /** SecretsStack for KMS key + the workflow-engine ↔ bot HS256 secret. */
  readonly secrets: SecretsStack;
  /**
   * Customer slug used as the prefix for AWS Secrets Manager paths
   * (`axira-teams-bot/<slug>/*`). Defaults to a name derived from
   * `envCfg.name` if absent.
   */
  readonly customerSlug?: string;
  /**
   * When true (default), the task definition uses a public nginx placeholder
   * image. Flip to false once the operator has pushed the real apps/teams-bot
   * image to the ECR repo.
   */
  readonly usePlaceholderImage?: boolean;
}

function deriveCustomerSlug(envCfg: EnvConfig): string {
  // axira-staging  → axira
  // genesis-staging → genesis
  // genesis-prod    → genesis
  const head = envCfg.name.split("-")[0];
  return head && head.length > 0 ? head : envCfg.name;
}

export class MsteamsStack extends cdk.Stack {
  public readonly repo: ecr.Repository;
  public readonly service: ecs.FargateService;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: MsteamsStackProps,
  ) {
    super(scope, id, props);

    const customerSlug = props.customerSlug ?? deriveCustomerSlug(envCfg);
    const usePlaceholderImage = props.usePlaceholderImage ?? true;
    const isDev = !isProdEnv(envCfg.name);

    // ── KMS ────────────────────────────────────────────────────────────────
    // Dedicated CMK for this stack's ECR repo + log group. Encrypting those with
    // the shared `secrets.appKey` adds msteams resources to that key's policy —
    // and the policy lives in the secrets stack, which creates a
    // `secrets → msteams → compute → storage → secrets` dependency cycle that
    // blocks `cdk synth`. A stack-local key keeps CMK encryption without the
    // cross-stack grant. (The execution role still decrypts the shared
    // service-token secret via its explicit IAM grant on `secrets.appKey`.)
    const teamsKey = new kms.Key(this, "Key", {
      description: `axira-${envCfg.name}-teams-bot encryption key`,
      enableKeyRotation: true,
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    // ── ECR ────────────────────────────────────────────────────────────────
    this.repo = new ecr.Repository(this, "Repo", {
      repositoryName: `axira/${envCfg.name}/${SERVICE_NAME}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [
        { maxImageCount: 30, rulePriority: 1, tagStatus: ecr.TagStatus.ANY },
      ],
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: teamsKey,
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      emptyOnDelete: isDev,
    });

    // ── LogGroup ──────────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/axira/${envCfg.name}/${SERVICE_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: teamsKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── IAM (task + execution) ────────────────────────────────────────────
    const taskRole = new iam.Role(this, "TaskRole", {
      roleName: `axira-${envCfg.name}-teams-bot-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Runtime role for ${SERVICE_NAME} (${envCfg.name})`,
    });

    const customerSecretArnPattern = `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira-teams-bot/${customerSlug}/*`;
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          props.secrets.serviceTokenSecret.secretArn,
          customerSecretArnPattern,
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        resources: [props.secrets.appKey.keyArn],
      }),
    );
    // T2 wires SNS publish + SQS consume on axira-events-teams-notify; add
    // the bare minimum here so the operator can opt in early without a
    // second `cdk deploy`.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ChangeMessageVisibility",
        ],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:axira-${envCfg.name}-teams-notify*`,
        ],
      }),
    );

    const executionRole = new iam.Role(this, "ExecRole", {
      roleName: `axira-${envCfg.name}-teams-bot-exec-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [props.secrets.appKey.keyArn],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          props.secrets.serviceTokenSecret.secretArn,
          customerSecretArnPattern,
        ],
      }),
    );

    // ── Task definition + container ───────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: TASK_CPU,
      memoryLimitMiB: TASK_MEMORY,
      taskRole,
      executionRole,
    });

    const image: ecs.ContainerImage = usePlaceholderImage
      ? ecs.ContainerImage.fromRegistry(
          "public.ecr.aws/nginx/nginx:1.27-alpine",
        )
      : ecs.ContainerImage.fromEcrRepository(this.repo, "latest");

    // Secrets are referenced by SecretsManager ARN; loaded into the
    // container as env vars at task start. The bot's config/load-secrets.ts
    // reads them from process.env in production.
    const importedServiceTokenSecret =
      secretsmanager.Secret.fromSecretAttributes(
        this,
        "ServiceTokenSecretRef",
        {
          secretCompleteArn: props.secrets.serviceTokenSecret.secretArn,
          // Deliberately NO encryptionKey: importing it makes ecs.Secret grant
          // the exec role kms:Decrypt via secrets.appKey's policy (in the secrets
          // stack), re-introducing the secrets → msteams cycle edge. The exec
          // role already has an explicit IAM kms:Decrypt grant on appKey above,
          // which is sufficient to read the service-token secret.
        },
      );

    taskDef.addContainer("teams-bot", {
      image,
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: SERVICE_NAME, logGroup }),
      environment: {
        NODE_ENV: "production",
        PORT: String(CONTAINER_PORT),
        CUSTOMER_SLUG: customerSlug,
        LOG_LEVEL: "info",
        AXIRA_GATEWAY_URL: "http://gateway.axira.internal:3001",
        AWS_REGION: this.region,
      },
      secrets: {
        SERVICE_TOKEN_SECRET: ecs.Secret.fromSecretsManager(
          importedServiceTokenSecret,
        ),
      },
      portMappings: [
        { containerPort: CONTAINER_PORT, protocol: ecs.Protocol.TCP },
      ],
      healthCheck: {
        command: [
          "CMD-SHELL",
          `wget -qO- http://127.0.0.1:${CONTAINER_PORT}/healthz || exit 1`,
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(60),
      },
    });

    // ── Cloud Map service registration (private DNS) ──────────────────────
    const cloudMapOptions =
      props.shared.serviceDiscoveryNamespace !== undefined
        ? {
            cloudMapOptions: {
              name: "teams-bot",
              cloudMapNamespace: props.shared.serviceDiscoveryNamespace,
              dnsRecordType: servicediscovery.DnsRecordType.A,
              dnsTtl: Duration.seconds(60),
            },
          }
        : {};

    this.service = new ecs.FargateService(this, "Service", {
      serviceName: SERVICE_NAME,
      cluster: props.cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      ...(props.shared.serviceSg !== undefined
        ? { securityGroups: [props.shared.serviceSg] }
        : {}),
      healthCheckGracePeriod: Duration.seconds(120),
      circuitBreaker: { rollback: true },
      ...cloudMapOptions,
    });

    // ── ALB target group + listener rule ──────────────────────────────────
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, "Tg", {
      targetGroupName: `axira-${envCfg.name}-teams-bot`.slice(0, 32),
      vpc: props.shared.vpc,
      port: CONTAINER_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/healthz",
        port: String(CONTAINER_PORT),
        protocol: elbv2.Protocol.HTTP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(10),
    });
    this.targetGroup.addTarget(this.service);

    const host = `${SUBDOMAIN}.axira.${envCfg.domainName}`;
    new elbv2.ApplicationListenerRule(this, "ListenerRule", {
      listener: props.httpsListener,
      priority: 900,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([host]),
        elbv2.ListenerCondition.pathPatterns([
          "/api/messages",
          "/v1/notify",
          "/healthz",
          "/health",
        ]),
      ],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    new cdk.CfnOutput(this, "EcrRepoUri", {
      value: this.repo.repositoryUri,
      description: `ECR repo for ${SERVICE_NAME} — push tagged image then redeploy with usePlaceholderImage=false`,
    });
    new cdk.CfnOutput(this, "BotHost", {
      value: host,
      description:
        "Bot Framework messaging endpoint host (DNS must be wired in EdgeDnsStack)",
    });
    new cdk.CfnOutput(this, "CustomerSlug", {
      value: customerSlug,
      description: `Slug used for axira-teams-bot/<slug>/* secrets path`,
    });
  }
}
