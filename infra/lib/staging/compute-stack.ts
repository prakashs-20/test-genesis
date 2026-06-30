// ECR repositories, ALB with HTTPS listener, four platform Fargate services, autoscaling, IAM, and the docs portal.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_ecr as ecr,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_kms as kms,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_certificatemanager as acm,
  aws_servicediscovery as servicediscovery,
  aws_applicationautoscaling as appscaling,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig, ServiceDef } from "./config.js";
import type { SharedProps } from "./types.js";
import type { StorageStack } from "./storage-stack.js";
import type { SecretsStack } from "./secrets-stack.js";
import type { DatabaseStack } from "./database-stack.js";
import type { MessagingStack } from "./messaging-stack.js";
import type { ObservabilityStack } from "./observability-stack.js";
import type { AppConfigStack } from "./app-config-stack.js";

interface ImportedSecrets {
  readonly appKey: kms.IKey;
  readonly appDbSecret: secretsmanager.ISecret;
  readonly serviceTokenSecret: secretsmanager.ISecret;
  readonly providerSecrets: Record<string, secretsmanager.ISecret>;
}

const TEMPORAL_DNS = "temporal.axira.internal:7233";
const GATEWAY_INTERNAL_URL = "http://gateway.axira.internal:3001";
const AGENT_RUNTIME_INTERNAL_URL = "http://agent-runtime.axira.internal:3002";
// Liveness port the observability-alert-runner's health server binds (GET
// /health). MUST equal RUNNER_HEALTH_PORT injected into the container below and
// the app default in apps/observability-alert-runner/src/config.ts. The
// ops-plane infra-signal-collector probes alert-runner.axira.internal:<this>.
const ALERT_RUNNER_HEALTH_PORT = 3014;

export class ComputeStack extends cdk.Stack {
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;
  public readonly fargateServices: Record<string, ecs.FargateService> = {};
  public readonly targetGroups: Record<string, elbv2.ApplicationTargetGroup> =
    {};
  public readonly repos: Record<string, ecr.Repository> = {};
  // Per-service CloudWatch log groups, keyed by service name. Captured so the
  // db-migrate task definition can stream into the gateway's log group (the
  // migrate one-off task IS the gateway image) under a `db-migrate` prefix.
  private readonly serviceLogGroups: Record<string, logs.LogGroup> = {};
  private readonly observability!: ObservabilityStack;
  private readonly appConfigIds: {
    applicationId: string;
    environmentId: string;
    featureFlagsProfileId: string;
  };
  private readonly imported: ImportedSecrets;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    shared: SharedProps,
    cluster: ecs.ICluster,
    storage: StorageStack,
    secrets: SecretsStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    // Optional: when envCfg.httpsEnabled is false, EdgeCertStack passes
    // `undefined` here and ComputeStack serves HTTP-only on :80.
    cert: acm.ICertificate | undefined,
    observability: ObservabilityStack,
    appConfig: AppConfigStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);
    this.observability = observability;
    this.appConfigIds = {
      applicationId: appConfig.applicationId,
      environmentId: appConfig.environmentId,
      featureFlagsProfileId: appConfig.featureFlagsProfileId,
    };
    this.imported = this.importSecrets(secrets);

    // Staging envs (axira-staging, genesis-staging) keep ECR repos
    // DESTROY-able + `emptyOnDelete` so rollbacks clean up the repos and
    // their images. Only prod envs (genesis-prod, axira-los) retain —
    // production image history must survive accidental destroys.
    const isDev = !isProdEnv(envCfg.name);
    for (const svc of envCfg.services) {
      this.repos[svc.name] = new ecr.Repository(this, `Repo-${svc.name}`, {
        repositoryName: `axira/${envCfg.name}/${svc.name}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        lifecycleRules: [
          { maxImageCount: 30, rulePriority: 1, tagStatus: ecr.TagStatus.ANY },
        ],
        encryption: ecr.RepositoryEncryption.KMS,
        encryptionKey: secrets.appKey,
        removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
        emptyOnDelete: isDev,
      });
    }

    // vpn private-access (e.g. genesis-prod): the customer reaches the ALB over
    // their own VPN, so the ALB is INTERNAL (private subnets, private IPs only) —
    // there is no public scheme and no cloudflared connector. Every other mode
    // (cloudflared WARP, CloudFront, plain public) keeps the internet-facing
    // scheme; "private" there is enforced by the ALB SG ingress (NetworkStack),
    // not the scheme. The ALB DNS name is emitted as AlbDnsName (below) for the
    // customer to point THEIR own DNS at (Axira writes no DNS in vpn mode).
    const isVpnPrivate =
      envCfg.privateAccess?.enabled && envCfg.privateAccess.mode === "vpn";
    this.alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: `axira-${envCfg.name}-alb`,
      vpc: shared.vpc,
      internetFacing: !isVpnPrivate,
      ...(isVpnPrivate
        ? { vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS } }
        : {}),
      securityGroup: shared.albSg,
      idleTimeout: Duration.seconds(60),
      http2Enabled: true,
    });
    this.alb.logAccessLogs(storage.buckets["alb-logs"]!, "alb");

    // Private-access (Cloudflare Tunnel + WARP) supplies its own ALB cert,
    // imported here from privateAccess.albCertArn, so the ALB serves HTTPS :443
    // even though httpsEnabled=false (the genesis-capital.com EdgeCertStack path
    // can't DNS-validate). The browser connects straight to the ALB over the
    // tunnel, so it must present a browser-trusted cert. Takes precedence over
    // the EdgeCertStack `cert`.
    const albCert: acm.ICertificate | undefined = envCfg.privateAccess?.enabled
      ? acm.Certificate.fromCertificateArn(
          this,
          "AlbPrivateCert",
          envCfg.privateAccess.albCertArn,
        )
      : cert;

    // Listener strategy:
    //   - cert supplied (httpsEnabled=true OR privateAccess): HTTPS :443 + HTTP→HTTPS redirect.
    //   - no cert (httpsEnabled=false, axira-staging only): plain HTTP :80.
    // The `httpsListener` field name is preserved either way — it's the
    // listener that target groups and listener rules attach to.
    // `open: false` on every listener: the ALB SG ingress is managed solely in
    // NetworkStack (anyIpv4 normally, or the CloudFront origin-facing prefix
    // list when cloudFront.enabled). Without this, addListener auto-adds a
    // 0.0.0.0/0 ingress rule for the listener port, re-opening the ALB and
    // defeating the CloudFront origin lock.
    if (albCert) {
      this.httpsListener = this.alb.addListener("Https", {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [albCert],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: "text/plain",
          messageBody: "Not found",
        }),
      });
      this.alb.addListener("HttpRedirect", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: "HTTPS",
          port: "443",
          permanent: true,
        }),
      });
      // Additional SNI certs (private-access): a wildcard `*.<apex>` so
      // subdomain hosts (e.g. privateAccess.adminAlias) present a trusted cert.
      // The default `albCert` (apex) stays the listener's default certificate.
      const extraCerts = envCfg.privateAccess?.additionalCertArns ?? [];
      if (extraCerts.length > 0) {
        this.httpsListener.addCertificates(
          "PrivateAccessSniCerts",
          extraCerts.map((arn) => elbv2.ListenerCertificate.fromArn(arn)),
        );
      }
    } else {
      this.httpsListener = this.alb.addListener("Http", {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: "text/plain",
          messageBody: "Not found",
        }),
      });
    }

    for (const svc of envCfg.services) {
      this.fargateServices[svc.name] = this.createService(
        envCfg,
        svc,
        shared,
        cluster,
        storage,
        secrets,
        database,
        messaging,
      );
    }

    // db-migrate task definition (no service): a one-off Fargate task on the
    // gateway image that runs `node scripts/migrate.mjs` against the platform
    // DB. The deploy pipeline pins the gateway container to :<sha>, registers a
    // run-family revision, and `run-task`s it AFTER the real image is mirrored
    // to ECR but BEFORE services flip onto it — so services never boot against
    // an unmigrated schema. Created unconditionally (incl. placeholder
    // bootstrap): it only REFERENCES the gateway ECR image, never pulls it at
    // synth/deploy, so a fresh env's empty ECR is fine.
    this.createMigrateTaskDefinition(envCfg, secrets, database);

    const docsService = this.createDocsService(
      envCfg,
      shared,
      cluster,
      secrets,
    );
    this.fargateServices["axira-docs"] = docsService;

    // observability-alert-runner: headless platform worker (no ALB, no port).
    // Moved here from the ops-plane stack (2026-06-24) because it reads the
    // PLATFORM's customer tenant_alert_rules + tenant_scheduled_reports and
    // POSTs the PLATFORM gateway — both are platform/customer-side deps, not
    // Axira-wide ops-plane state.
    const alertRunnerService = this.createAlertRunnerService(
      envCfg,
      shared,
      cluster,
      secrets,
      database,
    );
    this.fargateServices["observability-alert-runner"] = alertRunnerService;

    new CfnOutput(this, "AlbDnsName", {
      value: this.alb.loadBalancerDnsName,
      description: isVpnPrivate
        ? "INTERNAL ALB DNS name. The customer points THEIR own DNS (e.g. a " +
          "Route 53 ALIAS/CNAME for the app + admin hosts) at this — Axira " +
          "writes no DNS for vpn private-access. Resolves to private IPs " +
          "reachable only over the customer VPN."
        : "ALB DNS name.",
    });
    new CfnOutput(this, "AlbArn", { value: this.alb.loadBalancerArn });
  }

  // Import the upstream KMS key and Secrets Manager entries as IKey/ISecret references.
  // Grants on imported references mutate only identity policies, never the upstream
  // resource policy, which is what breaks the Secrets ↔ Compute ↔ Storage cycle.
  // appDbSecret comes from DatabaseStack (where it's owned alongside the rotation
  // schedule); everything else comes from SecretsStack.
  private importSecrets(secrets: SecretsStack): ImportedSecrets {
    const appKey = kms.Key.fromKeyArn(this, "AppKeyRef", secrets.appKey.keyArn);
    const importSecret = (
      id: string,
      secret: secretsmanager.Secret,
    ): secretsmanager.ISecret =>
      secretsmanager.Secret.fromSecretAttributes(this, id, {
        secretCompleteArn: secret.secretArn,
        encryptionKey: appKey,
      });
    const providerSecrets: Record<string, secretsmanager.ISecret> = {};
    for (const [name, sec] of Object.entries(secrets.providerSecrets)) {
      providerSecrets[name] = importSecret(`Provider-${name}-Ref`, sec);
    }
    return {
      appKey,
      appDbSecret: importSecret("AppDbSecretRef", secrets.appDbSecret),
      serviceTokenSecret: importSecret(
        "ServiceTokenSecretRef",
        secrets.serviceTokenSecret,
      ),
      providerSecrets,
    };
  }

  private createService(
    envCfg: EnvConfig,
    svc: ServiceDef,
    shared: SharedProps,
    cluster: ecs.ICluster,
    storage: StorageStack,
    secrets: SecretsStack,
    database: DatabaseStack,
    messaging: MessagingStack,
  ): ecs.FargateService {
    const logGroup = new logs.LogGroup(this, `Logs-${svc.name}`, {
      logGroupName: `/axira/${envCfg.name}/${svc.name}`,
      retention: this.logRetentionFromDays(envCfg.retention.logRetentionDays),
      encryptionKey: this.imported.appKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // Expose the gateway (and every other) service log group so the
    // db-migrate task definition can reuse the gateway's group.
    this.serviceLogGroups[svc.name] = logGroup;

    const taskRole = new iam.Role(this, `TaskRole-${svc.name}`, {
      roleName: `axira-${envCfg.name}-${svc.name.replace("axira-", "")}-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Runtime role for ${svc.name} (${envCfg.name})`,
    });

    // S3 bucket access via identity-side IAM only. Calling bucket.grantReadWrite()
    // chains into bucket.encryptionKey.grant*() which mutates the upstream KMS key
    // resource policy and creates a Secrets→Compute edge. Inlining keeps it one-way.
    const dataBucketArns: string[] = [];
    for (const [name, bucket] of Object.entries(storage.buckets)) {
      if (name === "alb-logs") continue;
      dataBucketArns.push(bucket.bucketArn, `${bucket.bucketArn}/*`);
    }
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        resources: dataBucketArns,
      }),
    );

    // IMPORTANT: never call `secret.grantRead(taskRole)` or
    // `appKey.grantEncryptDecrypt(taskRole)` directly when the role and the
    // resource live in different stacks. CDK adds a resource policy on the
    // secret/key referencing the role ARN, which creates a SecretsStack ->
    // ComputeStack dependency and (combined with Storage->Secrets via KMS)
    // produces a cyclic stack reference. Use addToPolicy on the role instead;
    // this only mutates the role's inline policy in ComputeStack and keeps
    // the dependency direction Compute -> Secrets.
    const allReadableSecretArns = [
      ...Object.values(secrets.providerSecrets).map((s) => s.secretArn),
      secrets.appDbSecret.secretArn,
      secrets.serviceTokenSecret.secretArn,
      // The gateway validates the alert-runner's calls against this shared
      // token; the observability-alert-runner worker presents the same value.
      secrets.alertRunnerServiceTokenSecret.secretArn,
    ];

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          ...allReadableSecretArns,
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira/tenant/*`,
        ],
      }),
    );

    // The gateway owns per-tenant connector credentials. The admin connector
    // flow (PUT /v1/admin/connectors/instances/<id>/credentials, handler
    // apps/gateway/src/gateways/.../connectors) writes each instance's secret
    // to axira/tenant/<tenant>/connector/<id> in Secrets Manager. The shared
    // read grant above only covers GetSecretValue/DescribeSecret, so the write
    // path 500s without Create/Put/Update/Delete + TagResource. Gateway-only:
    // no other service mutates tenant connector secrets. CreateSecret has no
    // pre-existing ARN to scope to, so it (and TagResource at create time) is
    // authorized against the same axira/tenant/* namespace. Resource path is
    // parameterized per env, so genesis-prod gets the identical grant.
    if (svc.name === "axira-gateway") {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "secretsmanager:CreateSecret",
            "secretsmanager:PutSecretValue",
            "secretsmanager:UpdateSecret",
            "secretsmanager:DeleteSecret",
            "secretsmanager:GetSecretValue",
            "secretsmanager:DescribeSecret",
            "secretsmanager:TagResource",
          ],
          resources: [
            `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira/tenant/*`,
          ],
        }),
      );
    }

    // The workflow-engine's ops publisher resolves the per-customer HMAC signing
    // secret itself (the ARN arrives as the PLAIN env var AXIRA_OPS_HMAC_SECRET_REF,
    // not an ECS `secrets` entry), so the task role needs GetSecretValue on exactly
    // that ARN. Scoped to the one secret; only the wfe emits ops events. Gated on
    // envCfg.opsEmitter, so envs without a receiver grant nothing.
    if (svc.name === "axira-workflow-engine" && envCfg.opsEmitter) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [envCfg.opsEmitter.hmacSecretArn],
        }),
      );
    }

    // SESv2 senders (transactional email via the task-role default creds):
    //   - workflow-engine: the notify-email capability + notification-dispatcher
    //   - gateway: LOI / soft-quote / HITL emails sent directly
    //   - customer-central: borrower onboarding / verify / welcome emails
    // All send from the verified mail.axiralabs.ai identity (SES_FROM_EMAIL).
    // Previously scoped to workflow-engine only, so gateway/customer-central
    // sends would fail AccessDenied.
    if (
      [
        "axira-workflow-engine",
        "axira-gateway",
        "axira-customer-central",
      ].includes(svc.name)
    ) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["ses:SendEmail", "ses:SendRawEmail"],
          resources: ["*"],
        }),
      );
    }

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        resources: [secrets.appKey.keyArn],
      }),
    );

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish", "sns:GetTopicAttributes"],
        resources: [`${messaging.topicPrefix}-*`],
      }),
    );

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ChangeMessageVisibility",
          "sqs:SendMessage",
        ],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:axira-${envCfg.name}-*`,
        ],
      }),
    );

    // OpenSearch access via identity-side IAM only. domain.grantReadWrite() would
    // mutate the OpenSearch access policy in DatabaseStack with this task role ARN
    // and create a Database→Compute edge that, combined with the env-var token refs
    // already going Compute→Database, would close another cycle. Covers BOTH the
    // knowledge SEARCH domain (DatabaseStack) AND the dedicated LOGS domain
    // (ObservabilityStack): the gateway observability routes + timeline logs/
    // traces sources query the LOGS domain's axira-logs-* / axira-traces-* index
    // patterns, so the task role needs es:ESHttp* on that domain too. (The domains'
    // resource policies already allow in-VPC anonymous es:ESHttp*; this identity
    // grant keeps the principal authorized for parity / future SigV4 hardening.)
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "es:ESHttpGet",
          "es:ESHttpPost",
          "es:ESHttpPut",
          "es:ESHttpDelete",
          "es:ESHttpHead",
        ],
        resources: [
          database.opensearch.domainArn,
          `${database.opensearch.domainArn}/*`,
          this.observability.logsDomain.domainArn,
          `${this.observability.logsDomain.domainArn}/*`,
        ],
      }),
    );

    if (
      svc.bedrockInvoke &&
      envCfg.llmProvider === "bedrock" &&
      envCfg.bedrock.allowedModelIds.length > 0
    ) {
      // Bedrock IAM is granted ONLY when this env's LLM transport is Bedrock.
      // When llmProvider === "anthropic" the services talk the direct Anthropic
      // API (ANTHROPIC_API_KEY) and never call bedrock:InvokeModel, so no grant
      // is needed (e.g. the AWS-India / AISPL axira-los-staging account, where
      // Bedrock-Anthropic is unavailable).
      //
      // Cross-region inference profiles (the us.anthropic.* Claude 4 family)
      // need BOTH the inference-profile ARN (in this region, account-scoped)
      // AND the underlying foundation-model ARNs in every destination region
      // the profile may route to. Bare foundation-model ids (e.g. the directly
      // invokable 3.5 v2) only need the foundation-model ARN. We expand the
      // allow-list to cover all of these:
      //   - profile ids (start with "us."/"eu."/"apac.") → inference-profile
      //     ARN here + foundation-model ARNs (id minus the geo prefix) across
      //     the US destination regions.
      //   - foundation-model ids → foundation-model ARN across the US regions.
      // US cross-region inference for these profiles routes within us-east-1,
      // us-east-2, and us-west-2.
      const usRegions = ["us-east-1", "us-east-2", "us-west-2"];
      const isProfileId = (id: string): boolean => /^[a-z]{2,4}\./.test(id);
      const stripGeoPrefix = (id: string): string =>
        id.replace(/^[a-z]{2,4}\./, "");
      const resources = new Set<string>();
      for (const modelId of envCfg.bedrock.allowedModelIds) {
        if (isProfileId(modelId)) {
          // The invokable inference-profile resource (this region, this account).
          resources.add(
            `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${modelId}`,
          );
          // The foundation models the profile fans out to, in each US region.
          const fmId = stripGeoPrefix(modelId);
          for (const r of usRegions) {
            resources.add(`arn:aws:bedrock:${r}::foundation-model/${fmId}`);
          }
        } else {
          // Directly-invokable foundation model (this region is sufficient, but
          // grant all US regions for parity with the profile-routed models).
          for (const r of usRegions) {
            resources.add(`arn:aws:bedrock:${r}::foundation-model/${modelId}`);
          }
        }
      }
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
          resources: [...resources],
        }),
      );
    }

    // AppConfig DATA-plane access — runtime feature-flag reads (rulebook poller +
    // user-profile lane). The data plane authorizes against the *retrieval* ARN
    // `application/<app>/environment/<env>/configuration/<profile>` (note
    // `configuration`, nested under the environment) — NOT the control-plane
    // `application/<app>/configurationprofile/<profile>` ARN. Granting the latter
    // for StartConfigurationSession/GetLatestConfiguration never matches, so the
    // poller logs "not authorized to perform appconfig:StartConfigurationSession".
    // Wildcard the profile so per-tenant profiles (created at runtime) are covered.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "appconfig:StartConfigurationSession",
          "appconfig:GetLatestConfiguration",
        ],
        resources: [
          `arn:aws:appconfig:${this.region}:${this.account}:application/${this.appConfigIds.applicationId}/environment/${this.appConfigIds.environmentId}/configuration/*`,
        ],
      }),
    );

    // AppConfig CONTROL-plane access — the Admin Hub flag-management lane
    // (gateway → agent-runtime `/api/v1/admin/appconfig-flags/*`) reads + writes
    // hosted configuration versions, lists environments/strategies, starts
    // deployments, and creates per-tenant profiles. Without this the admin list
    // route's ListHostedConfigurationVersions call is denied, the handler throws,
    // and the Feature Flags page fails with HTTP 500. Scoped to this env's
    // application, its environment, and its (current + per-tenant) profiles;
    // ListDeploymentStrategies is account-level so it takes `*`.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "appconfig:ListHostedConfigurationVersions",
          "appconfig:GetHostedConfigurationVersion",
          "appconfig:CreateHostedConfigurationVersion",
          "appconfig:CreateConfigurationProfile",
          "appconfig:ListEnvironments",
          "appconfig:StartDeployment",
        ],
        resources: [
          `arn:aws:appconfig:${this.region}:${this.account}:application/${this.appConfigIds.applicationId}`,
          `arn:aws:appconfig:${this.region}:${this.account}:application/${this.appConfigIds.applicationId}/environment/${this.appConfigIds.environmentId}`,
          `arn:aws:appconfig:${this.region}:${this.account}:application/${this.appConfigIds.applicationId}/configurationprofile/*`,
        ],
      }),
    );
    // ListDeploymentStrategies is not resource-scoped (account-wide list).
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["appconfig:ListDeploymentStrategies"],
        resources: ["*"],
      }),
    );

    const executionRole = new iam.Role(this, `ExecRole-${svc.name}`, {
      roleName: `axira-${envCfg.name}-${svc.name.replace("axira-", "")}-exec-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    // Cross-stack KMS grant — add inline to the execution role instead of
    // calling key.grantDecrypt() to avoid the secrets -> compute dependency.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );
    // The execution role also needs to pull cross-stack Secrets Manager
    // entries that the container references via ecs.Secret.fromSecretsManager.
    // Grant explicitly here so CDK doesn't mutate the secret resource policy.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: allReadableSecretArns,
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(this, `TaskDef-${svc.name}`, {
      cpu: svc.cpu,
      memoryLimitMiB: svc.memoryMiB,
      taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    const environment: Record<string, string> = {
      NODE_ENV: isProdEnv(envCfg.name) ? "production" : "staging",
      AXIRA_ENV: envCfg.name,
      AWS_REGION: this.region,
      PORT: String(svc.containerPort),
      LOG_LEVEL: "info",

      // SES transactional email (notify-email capability + borrower/guarantor
      // invites). Send from the VERIFIED subdomain identity mail.axiralabs.ai
      // (Easy DKIM + custom MAIL FROM bounce.mail.axiralabs.ai), NOT the apex
      // no-reply@axiralabs.ai (unverified -> SES rejects). The SES client region
      // follows AWS_REGION above (us-west-2), where the identity, the
      // axira-transactional config set, and account-level bounce/complaint
      // suppression all live.
      SES_FROM_EMAIL: "Axira <no-reply@mail.axiralabs.ai>",

      DATABASE_HOST: database.auroraCluster.clusterEndpoint.hostname,
      DATABASE_PORT: "5432",
      DATABASE_NAME: "axira",
      DATABASE_READER_HOST: database.auroraReaderEndpoint,
      REDIS_HOST: database.redis.attrPrimaryEndPointAddress,
      REDIS_PORT: database.redis.attrPrimaryEndPointPort,
      REDIS_TLS: "true",
      OPENSEARCH_ENDPOINT: `https://${database.opensearch.domainEndpoint}`,
      TEMPORAL_ADDRESS: TEMPORAL_DNS,
      TEMPORAL_NAMESPACE: "axira",

      ...messaging.serviceQueueEnvVars,

      S3_DOCUMENTS_BUCKET: storage.buckets["documents"]!.bucketName,
      S3_EVIDENCE_BUCKET: storage.buckets["evidence"]!.bucketName,
      S3_EXPORTS_BUCKET: storage.buckets["exports"]!.bucketName,
      S3_ASSETS_BUCKET: storage.buckets["assets"]!.bucketName,
      S3_AUDIT_EXPORTS_BUCKET: storage.buckets["audit-exports"]!.bucketName,
      OTEL_LOGS_ENDPOINT: this.observability.otelCollectorEndpoint,
      OTEL_EXPORTER_OTLP_ENDPOINT: this.observability.otelCollectorEndpoint,
      OTEL_SERVICE_NAME: svc.name,
      PHOENIX_ENDPOINT: envCfg.phoenixEndpoint,
      CEDAR_AUTHZ_ENABLED: String(envCfg.featureFlags.cedarAuthzEnabled),
      AM_ENFORCEMENT_ENABLED: String(envCfg.featureFlags.amEnforcementEnabled),
      FEATURE_AUTHORITY_MATRIX: String(
        envCfg.featureFlags.authorityMatrixEnabled,
      ),
      AUTHORITY_MATRIX_STRICT: String(
        envCfg.featureFlags.authorityMatrixStrict,
      ),
      OBS_DYNAMIC_LEVEL_ENABLED: String(
        envCfg.featureFlags.obsDynamicLevelEnabled,
      ),
      // Service-to-service via Cloud Map. Both names exist because different call sites
      // in apps/experience read GATEWAY_URL and AXIRA_GATEWAY_URL.
      GATEWAY_URL: GATEWAY_INTERNAL_URL,
      AXIRA_GATEWAY_URL: GATEWAY_INTERNAL_URL,
      // ── Validation-audit fixes (axira-los-staging real-flip). Without these the
      //    services fall back to localhost / fail JWT audience / 503 each other. ──
      // Different call sites read GATEWAY_INTERNAL_URL and GATEWAY_BASE_URL.
      GATEWAY_INTERNAL_URL: GATEWAY_INTERNAL_URL,
      GATEWAY_BASE_URL: GATEWAY_INTERNAL_URL,
      // gateway->agent-runtime + workflow-engine->agent-runtime (Cloud Map).
      AXIRA_AGENT_RUNTIME_URL: AGENT_RUNTIME_INTERNAL_URL,
      // Services read OPENSEARCH_URL; OPENSEARCH_ENDPOINT above is unused by them.
      // This is the knowledge SEARCH domain (v3 search/actions/spine + spine indexer).
      OPENSEARCH_URL: `https://${database.opensearch.domainEndpoint}`,
      // Dedicated LOGS/TRACES domain (ObservabilityStack). The gateway's
      // observability routes (logs/traces/app-ops/dashboards/alerts) + the
      // timeline logs/traces sources query axira-logs-* / axira-traces-*, whose
      // index templates live ONLY on this domain — not on the SEARCH domain
      // above. The gateway container builds its observability OpenSearch client
      // from OPENSEARCH_LOGS_URL (falling back to OPENSEARCH_URL only for
      // single-cluster local dev). Without this, the Observability→Logs page
      // queries the SEARCH domain and 404s/returns empty (or, pre-resource-
      // policy-fix, 403/502). Parameterized per env, so genesis-prod is identical.
      OPENSEARCH_LOGS_URL: this.observability.logsDomainEndpoint,
      // Log SHIPPING (the populate-the-Logs-page unlock). `createLogger()` in
      // @axira/observability tees every redacted log record into the LOGS
      // domain's axira-logs-* indices ONLY when OBS_OPENSEARCH_LOGS_URL is set
      // (logger.ts gates the OpenSearchLogSink on it; unset == stdout-only).
      // The READ side (OPENSEARCH_LOGS_URL above) already points the gateway's
      // observability queries at this domain, but with no service shipping, the
      // axira-logs-* index never gets created and every query 200s with 0 hits.
      // Injecting the SAME endpoint here as the WRITE target makes every service
      // populate the domain. The sink writes UNSIGNED raw HTTP (best-effort
      // /_bulk, no SigV4), which the domain's open-in-VPC anonymous es:ESHttp*
      // resource policy accepts; reachability is gated by the logs SG (ECS svc
      // SG ingress), not IAM. (The task role also already carries es:ESHttp* on
      // this domain ARN above for parity / future SigV4 hardening — no IAM
      // change is needed for the unsigned path.) Parameterized per env, so
      // genesis-prod ships logs identically.
      OBS_OPENSEARCH_LOGS_URL: this.observability.logsDomainEndpoint,
      // Gateway JWT verifier audience + the Next apps' login-token audience.
      AUTH0_AUDIENCE:
        process.env["AXIRA_LOS_AUTH0_AUDIENCE"] ?? "https://api.axiralabs.ai",
      // Gateway WebAuthn RP origin + browser CORS allow-list (else localhost).
      AXIRA_EXPERIENCE_BASE_URL: `https://${envCfg.domainName}`,
      CORS_ORIGINS: [
        `https://${envCfg.domainName}`,
        envCfg.privateAccess?.adminAlias
          ? `https://${envCfg.privateAccess.adminAlias}`
          : "",
      ]
        .filter(Boolean)
        .join(","),
      // Durable Postgres-backed admin repos (else in-memory, lost on restart).
      ADMIN_PG_REPOS: "true",
      APPCONFIG_APPLICATION_ID: this.appConfigIds.applicationId,
      APPCONFIG_ENVIRONMENT_ID: this.appConfigIds.environmentId,
      APPCONFIG_PROFILE_ID: this.appConfigIds.featureFlagsProfileId,
    };

    // Single-tenant email-domain lock (OPT-IN, SECURITY-SENSITIVE). When the env
    // sets instanceEmailDomain (e.g. genesis-prod = genesiscapital.com), inject
    // it as INSTANCE_EMAIL_DOMAIN into the two services that enforce it
    // server-side: the gateway (@axira/auth isEmailAllowedForInstance in the
    // resolve-idp route, container.ts:3347/3381) and experience (the
    // /api/auth/* server reject + the BFF). The client login form's
    // NEXT_PUBLIC_INSTANCE_EMAIL_DOMAIN is baked at build time (Dockerfile +
    // image producers), not here. The Auth0-side enforcement is applied by the
    // deploy pipeline's auth0_setup job from the matching instance_email_domain
    // input. UNSET ⇒ nothing injected (lock inert), correct for shared staging.
    if (
      envCfg.instanceEmailDomain &&
      (svc.name === "axira-gateway" || svc.name === "axira-experience")
    ) {
      environment.INSTANCE_EMAIL_DOMAIN = envCfg.instanceEmailDomain;
    }

    // LLM provider + model ids for the LLM-invoking services (gateway identity
    // mapping-suggester; agent-runtime; workflow-engine). The transport is the
    // per-env `llmProvider`:
    //   • "bedrock"   — the Vercel AI SDK @ai-sdk/amazon-bedrock provider
    //     authenticates via the task IAM role (bedrock:InvokeModel granted
    //     above): NO ANTHROPIC_API_KEY, no external egress. Model ids must stay
    //     within `bedrock.allowedModelIds`; AWS_REGION (set above) selects the
    //     endpoint.
    //   • "anthropic" — the @ai-sdk/anthropic provider authenticates via
    //     ANTHROPIC_API_KEY (injected from the axira/<env>/anthropic secret in
    //     containerSecrets below). Used where Bedrock-Anthropic is unavailable
    //     (the AWS-India / AISPL axira-los-staging account). No Bedrock IAM is
    //     granted in this case. The canonical Anthropic model id defaults inside
    //     the client (claude-sonnet-4-5, overridable via ANTHROPIC_MODEL_ID).
    if (svc.bedrockInvoke) {
      if (envCfg.llmProvider === "anthropic") {
        // Selects the direct-Anthropic provider for every code path that reads
        // LLM_PROVIDER (gateway identity mapping-suggester; @axira/llm
        // defaultProvider()). ANTHROPIC_API_KEY is injected via containerSecrets
        // below; the gateway container THROWS at boot if it is selected without
        // a key (never a silent mock). No Bedrock env / model ids here — the
        // Bedrock client is not used on this env.
        environment.LLM_PROVIDER = "anthropic";
      } else {
        // Selects the real provider for every code path that reads LLM_PROVIDER
        // (gateway identity mapping-suggester; @axira/llm defaultProvider()).
        // WITHOUT this the suggester defaults to the mock provider and returns
        // no usable suggestions. `bedrock` = the platform standard (AI SDK +
        // @ai-sdk/amazon-bedrock, auth via the task role's bedrock:InvokeModel).
        environment.LLM_PROVIDER = "bedrock";
        // Conversational router (agent-runtime reads ROUTER_MODEL_ID).
        environment.ROUTER_MODEL_ID = envCfg.bedrock.routerModelId;
        // Document extraction — both env names are read across the code paths
        // (apps/agent-runtime extraction/llm.ts → EXTRACTION_MODEL;
        //  apps/workflow-engine container + v3 → AXIRA_EXTRACTOR_MODEL).
        environment.EXTRACTION_MODEL = envCfg.bedrock.extractionModelId;
        environment.AXIRA_EXTRACTOR_MODEL = envCfg.bedrock.extractionModelId;
        // The gateway identity mapping-suggester's AI-SDK Bedrock client reads
        // BEDROCK_MESSAGES_MODEL_ID (falling back to EXTRACTION_MODEL). Pin it to
        // the same Sonnet 4.5 inference-profile id (already in the allow-list).
        environment.BEDROCK_MESSAGES_MODEL_ID =
          envCfg.bedrock.extractionModelId;
      }
    }

    // Next.js standalone (experience, admin-hub) binds its HTTP server to
    // process.env.HOSTNAME. Fargate/Docker inject HOSTNAME=<container-host>
    // (e.g. ip-10-30-x-x) at runtime, overriding the image's
    // `ENV HOSTNAME=0.0.0.0` — so the server binds ONLY to the task ENI IP,
    // not loopback. The ECS container health check probes 127.0.0.1 →
    // ECONNREFUSED → task marked UNHEALTHY → circuit breaker. An explicit
    // task-def environment entry wins over the runtime injection, forcing a
    // 0.0.0.0 bind (loopback included). The Fastify services
    // (gateway/agent-runtime/workflow-engine) bind 0.0.0.0 in code and ignore
    // HOSTNAME, so this only matters for the Next apps.
    if (svc.name === "axira-experience" || svc.name === "axira-admin-hub") {
      environment.HOSTNAME = "0.0.0.0";
      // Public origin the Auth0 SDK uses for session-cookie scope + the
      // post-login returnTo (apps/experience/src/app/api/auth/[...auth0]
      // falls back to localhost:3000 without it). admin-hub lives on its
      // own subdomain; experience on the apex.
      // admin-hub is served at privateAccess.adminAlias over the tunnel (its
      // `admin.${domainName}` host is the undelegated genesis-capital one and
      // would make the Auth0 SDK's Universal-Login callback unreachable). Use
      // the alias so AUTH0_BASE_URL matches the host the browser actually hits.
      const host =
        svc.name === "axira-admin-hub" && envCfg.privateAccess?.adminAlias
          ? envCfg.privateAccess.adminAlias
          : svc.subdomain
            ? `${svc.subdomain}.${envCfg.domainName}`
            : envCfg.domainName;
      environment.AUTH0_BASE_URL = `https://${host}`;

      // Shared parent-domain session cookie so the workbench (apex host) and the
      // admin hub (admin.<apex> subdomain) SHARE one Auth0 session — visiting the
      // admin hub from a logged-in workbench no longer forces a second login.
      // @auth0/nextjs-auth0 reads AUTH0_COOKIE_DOMAIN (config.js) and sets the
      // `appSession` cookie's Domain to it; a leading-dot apex makes the cookie
      // sent to BOTH the apex and every subdomain. Without it the cookie is
      // host-only (apex) and the browser never sends it to the admin subdomain,
      // so admin-hub's middleware getSession() sees nothing → Universal Login.
      // Both apps decrypt the same JWE: identical AUTH0_SECRET (auth0 secret) and
      // identical session name (neither sets AUTH0_SESSION_NAME → "appSession").
      // Parameterized per env via the apex domainName (staging vs prod each get
      // their own). The custom ROPG seater (experience auth0-session.ts) reads
      // the same env var so the bank's /login path seats the cookie identically.
      environment.AUTH0_COOKIE_DOMAIN = `.${envCfg.domainName}`;

      // Session bounds (seconds). Honored by the @auth0/nextjs-auth0 SDK reader
      // on BOTH apps + the custom ROPG/passwordless seater (experience
      // auth0-session.ts reads AUTH0_SESSION_ABSOLUTE_DURATION for the cookie it
      // writes). The two apps decrypt the SAME shared cookie (AUTH0_COOKIE_DOMAIN
      // above), so the values MUST match on both — otherwise whichever app serves
      // a request re-stamps the cookie to its own config on autosave and the
      // bounds drift. SDK default without these: 24h idle / 7-day absolute.
      //   • ABSOLUTE 12h (43200s): hard cap from login, no extension.
      //   • ROLLING 35min (2100s): idle backstop. The real inactivity logout is
      //     driven client-side (experience InactivityManager — 30min, with a
      //     warning) because a server idle timeout can't tell a present operator
      //     from background polling/SSE. This rolling window only bites when
      //     there is NO traffic at all (the tab was closed), so a walked-away,
      //     closed workbench can't be resumed without re-auth. 35min > the
      //     client's 30min so the graceful client logout fires first on open tabs.
      environment.AUTH0_SESSION_ROLLING_DURATION = "2100";
      environment.AUTH0_SESSION_ABSOLUTE_DURATION = "43200";

      // ── Cross-app runtime origins (NEXT_PUBLIC replacement) ──
      // The Next apps read these AXIRA_*_URL vars SERVER-SIDE at request time
      // (runtime-config.server.ts) and surface them to client components via
      // RuntimeConfigProvider — they are NOT baked into the image. Injecting
      // them here (not via Dockerfile build-args) means a PROMOTED (re-tagged)
      // image serves each env's OWN cross-app URLs (mirrors AXIRA_GATEWAY_URL).
      //
      // experience + admin-hub origins auto-derive from the env's own hosts
      // (apex domainName + privateAccess.adminAlias) unless explicitly overridden
      // in appUrls. customer-central + ops-console are OPTIONAL: injected only
      // when appUrls supplies them (i.e. the env actually deploys/links those
      // separate apps); otherwise the app's localhost dev fallback applies and is
      // inert for a deployment that never navigates to them. Parameterized per
      // env, so genesis-prod/staging/los each get their own without code change.
      const adminHost = envCfg.privateAccess?.adminAlias
        ? envCfg.privateAccess.adminAlias
        : `admin.${envCfg.domainName}`;
      const experienceUrl =
        envCfg.appUrls?.experienceUrl ?? `https://${envCfg.domainName}`;
      const adminHubUrl = envCfg.appUrls?.adminHubUrl ?? `https://${adminHost}`;
      environment.AXIRA_EXPERIENCE_URL = experienceUrl;
      environment.AXIRA_ADMIN_HUB_URL = adminHubUrl;
      if (envCfg.appUrls?.customerCentralUrl) {
        environment.AXIRA_CUSTOMER_CENTRAL_URL =
          envCfg.appUrls.customerCentralUrl;
      }
      if (envCfg.appUrls?.opsConsoleUrl) {
        environment.AXIRA_OPS_CONSOLE_URL = envCfg.appUrls.opsConsoleUrl;
      }
    }

    // Customer-side ops-emitter env for the workflow-engine — the single egress
    // that ships this env's ops events to the Axira ops-plane receiver, PLUS the
    // infra-signal-collector that probes each service's /health and emits
    // `service.snapshot`. This was a LIVE hand-patch on the running task def;
    // codifying it here means a `cdk deploy` no longer silently wipes it (which
    // would kill the Services/Errors feed). HMAC secret is passed as a PLAIN env
    // var holding the ARN — the wfe resolves it itself via the SDK (NOT an ECS
    // `secrets` entry); the task-role grant for it is added in the IAM section
    // above. Gated on envCfg.opsEmitter, so envs without a receiver stay dark.
    if (svc.name === "axira-workflow-engine" && envCfg.opsEmitter) {
      environment.AXIRA_OPS_ENDPOINT = envCfg.opsEmitter.endpoint;
      environment.AXIRA_OPS_CUSTOMER_SLUG = envCfg.opsEmitter.customerSlug;
      environment.AXIRA_OPS_HMAC_SECRET_REF = envCfg.opsEmitter.hmacSecretArn;
      environment.AXIRA_OPS_ERROR_GROUPS_ENABLED = String(
        envCfg.opsEmitter.errorGroupsEnabled,
      );
      environment.INFRA_SIGNAL_COLLECTOR_ENABLED = String(
        envCfg.opsEmitter.infraSignalCollectorEnabled,
      );
      environment.INFRA_COLLECTOR_SERVICE_HEALTH_URLS =
        envCfg.opsEmitter.serviceHealthUrls;
    }

    // Import cross-stack secrets so ecs.Secret.fromSecretsManager() does
    // not mutate the upstream Secret's resource policy. Granting on an
    // imported ISecret only adds to the role policy in ComputeStack —
    // breaks the secrets -> compute dependency that ecs.Secret causes.
    const importSecret = (id: string, arn: string): secretsmanager.ISecret =>
      secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `Imp-${svc.name}-${id}`,
        arn,
      );

    const importedAppDb = importSecret("AppDb", secrets.appDbSecret.secretArn);
    const importedAuth0 = importSecret(
      "Auth0",
      secrets.providerSecrets["auth0"]!.secretArn,
    );
    const importedAuth0M2m = importSecret(
      "Auth0M2m",
      secrets.providerSecrets["auth0-m2m"]!.secretArn,
    );
    const importedAuth0Mgmt = importSecret(
      "Auth0Mgmt",
      secrets.providerSecrets["auth0-mgmt"]!.secretArn,
    );
    const importedOpenfga = importSecret(
      "Openfga",
      secrets.providerSecrets["openfga"]!.secretArn,
    );
    const importedServiceToken = importSecret(
      "ServiceToken",
      secrets.serviceTokenSecret.secretArn,
    );

    const containerSecrets: Record<string, ecs.Secret> = {
      DATABASE_USERNAME: ecs.Secret.fromSecretsManager(
        importedAppDb,
        "username",
      ),
      DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
        importedAppDb,
        "password",
      ),
      AUTH0_DOMAIN: ecs.Secret.fromSecretsManager(importedAuth0, "domain"),
      AUTH0_CLIENT_ID: ecs.Secret.fromSecretsManager(importedAuth0, "clientId"),
      AUTH0_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        importedAuth0,
        "clientSecret",
      ),
      AUTH0_M2M_CLIENT_ID: ecs.Secret.fromSecretsManager(
        importedAuth0M2m,
        "clientId",
      ),
      AUTH0_M2M_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
        importedAuth0M2m,
        "clientSecret",
      ),
      OPENFGA_API_URL: ecs.Secret.fromSecretsManager(importedOpenfga, "apiUrl"),
      OPENFGA_STORE_ID: ecs.Secret.fromSecretsManager(
        importedOpenfga,
        "storeId",
      ),
      OPENFGA_MODEL_ID: ecs.Secret.fromSecretsManager(
        importedOpenfga,
        "modelId",
      ),
      // The canonical V2 model id (the tuple-sync engine). Written by the
      // OpenFgaStack bootstrap alongside storeId/modelId. Injecting it turns ON
      // the gateway's OpenFGASyncService + boot reconciler + outbox worker
      // (container.ts gates them on OPENFGA_CANONICAL_MODEL_ID being set).
      OPENFGA_CANONICAL_MODEL_ID: ecs.Secret.fromSecretsManager(
        importedOpenfga,
        "canonicalModelId",
      ),
      OPENFGA_API_TOKEN: ecs.Secret.fromSecretsManager(
        importedOpenfga,
        "apiToken",
      ),
      SERVICE_TOKEN_SECRET: ecs.Secret.fromSecretsManager(
        importedServiceToken,
        "secret",
      ),
    };

    // ANTHROPIC_API_KEY for envs on the direct-Anthropic LLM transport
    // (envCfg.llmProvider === "anthropic"), injected ONLY into the LLM-invoking
    // services (svc.bedrockInvoke selects the same set: gateway, agent-runtime,
    // workflow-engine). The gateway's identityLlmClient factory (and any
    // agent-runtime LLM call routed through the AI-SDK @ai-sdk/anthropic
    // provider) reads it; the container THROWS at boot if LLM_PROVIDER=anthropic
    // is set without it (never a silent mock). On bedrock-provider envs the key
    // is neither injected nor read. Value comes from the axira/<env>/anthropic
    // secret (key apiKey), seeded out-of-band (see _deploy-los.yml seed loop).
    if (svc.bedrockInvoke && envCfg.llmProvider === "anthropic") {
      const importedAnthropic = importSecret(
        "Anthropic",
        secrets.providerSecrets["anthropic"]!.secretArn,
      );
      containerSecrets.ANTHROPIC_API_KEY = ecs.Secret.fromSecretsManager(
        importedAnthropic,
        "apiKey",
      );
    }

    // The gateway is the ONLY platform service that validates the
    // observability-alert-runner's service-token-gated `_evaluate` / `_run`
    // calls (apps/gateway/src/composition/container.ts reads
    // process.env.ALERT_RUNNER_SERVICE_TOKEN; the report-runner reuses the same
    // value). Inject the shared secret here so the gateway and the runner
    // (createAlertRunnerService below) compare the SAME value. Plain-string
    // secret → no JSON field. Only the gateway needs it; the other platform
    // services don't.
    if (svc.name === "axira-gateway") {
      const importedAlertRunnerToken = importSecret(
        "AlertRunnerToken",
        secrets.alertRunnerServiceTokenSecret.secretArn,
      );
      containerSecrets.ALERT_RUNNER_SERVICE_TOKEN =
        ecs.Secret.fromSecretsManager(importedAlertRunnerToken);

      // Auth0 Management API credentials for the gateway's login-federation
      // connection-management endpoint
      // (GET/POST /v1/admin/identity/login-federation/auth0-connections, handler
      // apps/gateway/src/gateways/identity/auth0-mgmt.ts). The container builds
      // its Auth0 Mgmt client only when AUTH0_MGMT_CLIENT_ID +
      // AUTH0_MGMT_CLIENT_SECRET + AUTH0_DOMAIN are all set
      // (apps/gateway/src/composition/container.ts); otherwise the endpoint
      // returns 503 AUTH0_MGMT_NOT_CONFIGURED. AUTH0_DOMAIN is already injected
      // above (from the `auth0` secret). These two come from the dedicated
      // `auth0-mgmt` secret (a Management-API-scoped M2M app, distinct from the
      // org/user-provisioning `auth0-m2m` app). Gateway-only: no other service
      // talks to the Auth0 Management API.
      containerSecrets.AUTH0_MGMT_CLIENT_ID = ecs.Secret.fromSecretsManager(
        importedAuth0Mgmt,
        "clientId",
      );
      containerSecrets.AUTH0_MGMT_CLIENT_SECRET = ecs.Secret.fromSecretsManager(
        importedAuth0Mgmt,
        "clientSecret",
      );
    }

    // The Next.js apps (experience, admin-hub) use @auth0/nextjs-auth0 +
    // a custom session-cookie seater (apps/experience/src/shared/lib/
    // auth0-session.ts) that derives an AES-256-GCM key from AUTH0_SECRET via
    // HKDF. Without AUTH0_SECRET, every login throws `"secret" is required`
    // (HTTP 500) right after the Auth0 password grant succeeds. Inject it only
    // for the surfaces that seat sessions; the backends validate JWTs via JWKS
    // and don't need it.
    if (svc.name === "axira-experience" || svc.name === "axira-admin-hub") {
      containerSecrets.AUTH0_SECRET = ecs.Secret.fromSecretsManager(
        importedAuth0,
        "auth0Secret",
      );
      // The @auth0/nextjs-auth0 SDK's getSession() (called by every
      // authenticated page, e.g. /home) requires the full config — without
      // AUTH0_ISSUER_BASE_URL it throws `"issuerBaseURL" is required` → 500.
      // Stored as a secret field (`https://<domain>`) since the domain itself
      // is only available as a secret, not at synth time.
      containerSecrets.AUTH0_ISSUER_BASE_URL = ecs.Secret.fromSecretsManager(
        importedAuth0,
        "issuerBaseUrl",
      );
    }

    // Placeholder mode: serve nginx on port 80 instead of pulling the real
    // app image from ECR. Lets the stack reach CREATE_COMPLETE before any
    // application image has been built. Drop the env vars / secrets /
    // container healthcheck in placeholder mode — nginx doesn't use them
    // and they only add failure surface.
    // Per-service override wins over the env-wide flag, so a service whose
    // image isn't published yet can stay on the placeholder while the rest of
    // the env runs real images.
    const placeholder = svc.usePlaceholderImage ?? envCfg.usePlaceholderImage;
    const effectivePort = placeholder ? 80 : svc.containerPort;

    taskDef.addContainer(svc.name, {
      image: placeholder
        ? ecs.ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest")
        : ecs.ContainerImage.fromEcrRepository(this.repos[svc.name]!, "latest"),
      essential: true,
      portMappings: [
        { containerPort: effectivePort, protocol: ecs.Protocol.TCP },
      ],
      environment: placeholder ? { PLACEHOLDER: "true" } : environment,
      secrets: placeholder ? undefined : containerSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: svc.name, logGroup }),
      healthCheck: placeholder
        ? undefined
        : {
            // Node-based probe, NOT wget/curl: the app images are
            // node:22-slim (Debian slim) which ship neither, so a wget
            // CMD-SHELL exits 127 ("not found") and ECS marks every real
            // task UNHEALTHY → circuit breaker → rollback to nginx. `node`
            // is guaranteed present in these images.
            //
            // 127.0.0.1, NOT localhost: the experience/admin-hub images are
            // node:22-alpine (musl) whose resolver returns IPv6 ::1 first,
            // but the servers bind HOSTNAME=0.0.0.0 (IPv4 only) — so a
            // `localhost` probe hits [::1]:port → ECONNREFUSED → the task is
            // marked unhealthy. The literal IPv4 loopback dodges resolution.
            command: [
              "CMD-SHELL",
              `node -e "require('http').get('http://127.0.0.1:${svc.containerPort}${svc.healthCheckPath}',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"`,
            ],
            interval: Duration.seconds(30),
            timeout: Duration.seconds(5),
            retries: 3,
            startPeriod: Duration.seconds(60),
          },
      stopTimeout: Duration.seconds(30),
      readonlyRootFilesystem: false,
    });

    const fargateService = new ecs.FargateService(this, `Svc-${svc.name}`, {
      cluster,
      taskDefinition: taskDef,
      serviceName: `axira-${envCfg.name}-${svc.name.replace("axira-", "")}`,
      desiredCount: svc.minTasks,
      assignPublicIp: false,
      securityGroups: [shared.serviceSg!],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: !isProdEnv(envCfg.name),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      // Register every service in Cloud Map regardless of publicViaAlb so
      // service-to-service traffic (e.g. experience → gateway) stays inside the VPC
      // instead of hairpinning through the public ALB.
      cloudMapOptions: {
        cloudMapNamespace: shared.serviceDiscoveryNamespace!,
        name: svc.name.replace("axira-", ""),
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    if (svc.publicViaAlb) {
      // In placeholder mode the container is nginx listening on :80 with
      // default config — only the root path returns 200. Point the target
      // group at port 80 with path "/" so health checks pass without
      // touching the per-service healthCheckPath conventions.
      const tg = new elbv2.ApplicationTargetGroup(this, `Tg-${svc.name}`, {
        // No explicit targetGroupName. The placeholder→real flip changes the
        // target group `port` (80 → containerPort), which forces a replacement;
        // a fixed name makes CloudFormation collide on create-before-delete
        // ("target group ... already exists"). An auto-generated name lets the
        // replacement (and any future port change) proceed cleanly.
        //
        // G11: the placeholder→real flip replaces this target group (the port
        // changes 80 → containerPort). For that replacement to succeed, NOTHING
        // outside this stack may import the TG's TargetGroupFullName — a
        // cross-stack import pins the export and CFN blocks the update ("Cannot
        // update export ... as it is in use by <env>-monitoring"), rolling the
        // flip back. The UnHealthyHostCount alarm that needs that value is
        // therefore defined IN THIS STACK just below (not in MonitoringStack),
        // so the replacement is purely intra-stack and never blocked. Do NOT add
        // a fixed targetGroupName here, and do NOT export this TG to another
        // stack.
        // CAVEAT to verify on the FIRST fresh-prod (genesis-prod) deploy: a
        // target group that is still referenced by a listener rule cannot be
        // replaced ("Target group ... is currently in use by a listener ...
        // and can't be deleted"). On the staging envs the placeholder bootstrap
        // and the real flip happen in the same pipeline run before any listener
        // rule is load-bearing, so the replacement succeeds; confirm the same on
        // the first genesis-prod bring-up. If CFN ever blocks on "in use",
        // deploy the topology once on the placeholder (port 80) and let the
        // real-image flip happen on the NEXT run so the rule re-points cleanly.
        vpc: shared.vpc,
        port: effectivePort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        targets: [fargateService],
        healthCheck: {
          path: placeholder ? "/" : svc.healthCheckPath,
          healthyHttpCodes: "200",
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          unhealthyThresholdCount: 3,
          healthyThresholdCount: 2,
        },
        deregistrationDelay: Duration.seconds(30),
      });
      this.targetGroups[svc.name] = tg;

      const conditions: elbv2.ListenerCondition[] = [];
      const hostHeader =
        svc.name === "axira-admin-hub" && envCfg.privateAccess?.adminAlias
          ? envCfg.privateAccess.adminAlias
          : (svc.hostHeader ??
            (svc.subdomain
              ? `${svc.subdomain}.${envCfg.domainName}`
              : undefined));
      if (hostHeader)
        conditions.push(elbv2.ListenerCondition.hostHeaders([hostHeader]));
      if (svc.pathPatterns)
        conditions.push(
          elbv2.ListenerCondition.pathPatterns([...svc.pathPatterns]),
        );
      if (conditions.length === 0)
        conditions.push(elbv2.ListenerCondition.pathPatterns(["/*"]));

      this.httpsListener.addAction(`Rule-${svc.name}`, {
        priority: svc.priority ?? 100,
        conditions,
        action: elbv2.ListenerAction.forward([tg]),
      });

      // Per-target-group UnHealthyHostCount > 0 alarm, co-located with the TG it
      // watches. This lives HERE (not in MonitoringStack) on purpose: reading
      // the TargetGroupFullName from another stack forces CloudFormation to
      // export `Fn::GetAtt <Tg> TargetGroupFullName` out of ComputeStack. The
      // placeholder→real flip changes the TG `port` (80 → containerPort), which
      // REPLACES the target group and therefore changes that exported value —
      // and CFN refuses to update an export that another stack imports ("Cannot
      // update export ... as it is in use by <env>-monitoring"), rolling the
      // whole compute update (the flip) back. Defining the alarm in the same
      // stack as the TG removes the cross-stack export entirely, so the flip can
      // replace the TG freely — including on a fresh first deploy that
      // bootstraps on the nginx placeholder and then flips to the real image.
      // Registered AFTER addAction so the TG is attached to the listener —
      // tg.metrics.* throws TargetGroupNeedsAttachedLoadBalancer otherwise. The
      // metric resolves to in-stack Refs (no Fn::ImportValue). Same metric /
      // threshold / action as the previous MonitoringStack alarm, so the page
      // behavior is unchanged.
      new cloudwatch.Alarm(this, `UnhealthyHosts-${svc.name}`, {
        alarmName: `axira-${envCfg.name}-${svc.name}-unhealthy-hosts`,
        metric: tg.metrics.unhealthyHostCount({
          period: Duration.minutes(1),
          statistic: "Maximum",
        }),
        threshold: 0,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${svc.name}: at least one target unhealthy for 3 minutes.`,
      }).addAlarmAction(new cw_actions.SnsAction(messaging.opsAlarmTopic));
    }

    const scaling = fargateService.autoScaleTaskCount({
      minCapacity: svc.minTasks,
      maxCapacity: svc.maxTasks,
    });
    scaling.scaleOnCpuUtilization(`Cpu-${svc.name}`, {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.seconds(180),
      scaleOutCooldown: Duration.seconds(60),
    });
    scaling.scaleOnMemoryUtilization(`Mem-${svc.name}`, {
      targetUtilizationPercent: 75,
      scaleInCooldown: Duration.seconds(180),
      scaleOutCooldown: Duration.seconds(60),
    });

    // ALB request-count target tracking, in addition to CPU/mem. Only the two
    // public ALB-fronted services that own a target group here participate:
    // axira-gateway and axira-experience. The internal services
    // (agent-runtime, workflow-engine) have no target group, and admin-hub
    // stays CPU-only by design. The target group is the one created above for
    // this service. 800 requests/target keeps each task comfortably under its
    // per-task throughput before a scale-out kicks in.
    if (
      (svc.name === "axira-gateway" || svc.name === "axira-experience") &&
      this.targetGroups[svc.name]
    ) {
      scaling.scaleOnRequestCount(`Req-${svc.name}`, {
        requestsPerTarget: 800,
        targetGroup: this.targetGroups[svc.name]!,
        scaleInCooldown: Duration.seconds(180),
        scaleOutCooldown: Duration.seconds(60),
      });
    }

    if (svc.scaleOnSqsQueue) {
      const bundle = messaging.queues[svc.scaleOnSqsQueue];
      if (bundle) {
        scaling.scaleOnMetric(`SqsDepth-${svc.name}`, {
          metric: bundle.main.metricApproximateNumberOfMessagesVisible({
            period: Duration.minutes(1),
          }),
          scalingSteps: [
            { upper: 10, change: 0 },
            { lower: 100, change: +1 },
            { lower: 500, change: +2 },
          ],
          adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
          cooldown: Duration.seconds(120),
        });
      }
    }

    return fargateService;
  }

  // db-migrate — a one-off, service-less Fargate task definition that runs the
  // canonical migrator (`node scripts/migrate.mjs`) on the GATEWAY image
  // (the gateway image bundles `migrations/` + `scripts/migrate.mjs` + `psql`).
  //
  // WHY this lives in CDK (not as a pipeline-assembled task def cloned from the
  // gateway SERVICE): on a fresh env the gateway service runs the nginx
  // placeholder with NO DB secrets until the post-migrate flip, so a task def
  // derived from it can't connect. This task def is self-sufficient — it injects
  // DATABASE_* from the `postgres-app` secret directly and carries its own
  // execution/task roles granted read on that secret + pull on the gateway ECR
  // repo + CloudWatch Logs write. No human ever has to grant the exec role
  // secretsmanager:GetSecretValue by hand.
  //
  // The pipeline (`.github/workflows/_deploy-los.yml` → migrate job) describes
  // this family, jq-pins the `axira-gateway` container image to :<sha> under a
  // run-family revision, registers it, and `run-task`s it with the gateway
  // service's subnets+SG — AFTER `mirror` (real image in ECR) and BEFORE
  // `cdk_finalize` (the flip). The container name stays `axira-gateway` so the
  // pipeline's image-pin selector and `containerOverrides[].name` match.
  //
  // Created unconditionally, including the placeholder bootstrap: a task
  // definition only REFERENCES its image (it is not pulled until run-task), so a
  // fresh env's empty ECR is fine. No FargateService is created — nothing runs
  // until the pipeline invokes it.
  private createMigrateTaskDefinition(
    envCfg: EnvConfig,
    secrets: SecretsStack,
    database: DatabaseStack,
  ): ecs.FargateTaskDefinition {
    const family = `axira-${envCfg.name}-db-migrate`;

    // Dedicated execution + task roles. Cross-stack reads use addToPolicy ONLY
    // (never secret.grantRead / key.grant*) so the upstream Secrets/KMS resource
    // policies are NOT mutated — otherwise CDK adds a SecretsStack -> ComputeStack
    // edge that (with Storage -> Secrets via KMS) cycles the stack graph. Same
    // precedent as createService / createAlertRunnerService above.
    const executionRole = new iam.Role(this, "ExecRole-db-migrate", {
      roleName: `axira-${envCfg.name}-db-migrate-exec-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Execution role for the ${family} one-off migrate task. Pulls the gateway image from ECR, reads the postgres-app secret, writes logs.`,
      // ECR pull (incl. the gateway repo) + CloudWatch Logs PutLogEvents.
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });
    // Decrypt the gateway ECR image layers + the postgres-app secret (both
    // KMS-encrypted with the platform CMK).
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );
    // THE grant that previously had to be made by hand: let the execution role
    // resolve the DATABASE_USERNAME/DATABASE_PASSWORD ecs.Secret refs at task
    // start. Scoped to the single postgres-app secret.
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [secrets.appDbSecret.secretArn],
      }),
    );

    const taskRole = new iam.Role(this, "TaskRole-db-migrate", {
      roleName: `axira-${envCfg.name}-db-migrate-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Runtime role for the ${family} one-off migrate task. Reads the postgres-app secret; runs migrations against the platform DB.`,
    });
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [secrets.appDbSecret.secretArn],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(this, "TaskDef-db-migrate", {
      family,
      cpu: 1024,
      memoryLimitMiB: 2048,
      taskRole,
      executionRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
    });

    // Import the postgres-app secret so ecs.Secret.fromSecretsManager() grants
    // on the role only (addToPolicy above), not on the upstream secret policy.
    const importedAppDb = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "Imp-db-migrate-AppDb",
      secrets.appDbSecret.secretArn,
    );

    // Stream into the GATEWAY log group (this task IS the gateway image) under a
    // `db-migrate` prefix so migrate runs are findable alongside the gateway's.
    // The gateway log group was captured by createService() above; it always
    // exists because axira-gateway is always in envCfg.services.
    const logGroup = this.serviceLogGroups["axira-gateway"]!;

    // DATABASE_URL is assembled from these parts at run time by the migrate
    // command (same formula as packages/db/src/connection-env.ts:
    // postgresql://<user>:<pass>@<host>:<port>/<name>?sslmode=require). HOST/
    // PORT/NAME are plain env (non-secret); USERNAME/PASSWORD come from the
    // postgres-app secret.
    const migrateCommand =
      'const u=encodeURIComponent(process.env.DATABASE_USERNAME||""),' +
      'p=encodeURIComponent(process.env.DATABASE_PASSWORD||""),' +
      "h=process.env.DATABASE_HOST," +
      'pt=process.env.DATABASE_PORT||"5432",' +
      'n=process.env.DATABASE_NAME||"axira";' +
      'process.env.DATABASE_URL="postgresql://"+u+":"+p+"@"+h+":"+pt+"/"+n+"?sslmode=require";' +
      'require("child_process").execFileSync("node",["scripts/migrate.mjs"],{stdio:"inherit",env:process.env});';

    // Container name MUST be `axira-gateway` — the pipeline's jq image-pin
    // selector (`.image | test("axira-gateway")`) and the run-task
    // containerOverrides target this exact name.
    taskDef.addContainer("axira-gateway", {
      // :latest base; the pipeline pins :<sha> at run time. Never pulled at
      // synth/deploy — only when the pipeline `run-task`s the registered
      // revision (post-mirror, so the image exists).
      image: ecs.ContainerImage.fromEcrRepository(
        this.repos["axira-gateway"]!,
        "latest",
      ),
      essential: true,
      // Default command runs the migrator, so the task def is runnable as-is
      // (the pipeline overrides it with the identical command anyway).
      command: ["node", "-e", migrateCommand],
      environment: {
        NODE_ENV: isProdEnv(envCfg.name) ? "production" : "staging",
        AXIRA_ENV: envCfg.name,
        AWS_REGION: this.region,
        LOG_LEVEL: "info",
        DATABASE_HOST: database.auroraCluster.clusterEndpoint.hostname,
        DATABASE_PORT: "5432",
        DATABASE_NAME: "axira",
      },
      secrets: {
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(
          importedAppDb,
          "username",
        ),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
          importedAppDb,
          "password",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "db-migrate", logGroup }),
      // No port mappings, no health check: this is a run-to-completion task.
      stopTimeout: Duration.seconds(120),
      readonlyRootFilesystem: false,
    });

    new CfnOutput(this, "DbMigrateTaskDefFamily", { value: family });

    return taskDef;
  }

  // observability-alert-runner — headless platform worker.
  //
  // A leader-locked scheduler (1 task): it polls the platform DB for due
  // tenant_alert_rules + tenant_scheduled_reports and POSTs the platform
  // gateway's service-token-gated `_evaluate` / `_run` endpoints. It has NO
  // HTTP server, so: NO portMappings, NO ALB target group, NO listener rule,
  // NO container health check. Mirrors the docs/platform task-role +
  // log-group + circuitBreaker pattern; registered in Cloud Map so it can
  // reach the gateway at gateway.axira.internal inside the VPC.
  private createAlertRunnerService(
    envCfg: EnvConfig,
    shared: SharedProps,
    cluster: ecs.ICluster,
    secrets: SecretsStack,
    database: DatabaseStack,
  ): ecs.FargateService {
    const serviceName = "observability-alert-runner";

    // Match the platform-service ECR naming convention exactly:
    // axira/<env>/<service>. Only genesis-prod retains; staging destroys +
    // emptyOnDelete so rollbacks don't strand the repo.
    const isDev = envCfg.name !== "genesis-prod";
    const repo = new ecr.Repository(this, `Repo-${serviceName}`, {
      repositoryName: `axira/${envCfg.name}/${serviceName}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [
        { maxImageCount: 30, rulePriority: 1, tagStatus: ecr.TagStatus.ANY },
      ],
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.imported.appKey,
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      emptyOnDelete: isDev,
    });
    this.repos[serviceName] = repo;

    const logGroup = new logs.LogGroup(this, `Logs-${serviceName}`, {
      logGroupName: `/axira/${envCfg.name}/${serviceName}`,
      retention: this.logRetentionFromDays(envCfg.retention.logRetentionDays),
      encryptionKey: this.imported.appKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, `TaskRole-${serviceName}`, {
      roleName: `axira-${envCfg.name}-alert-runner-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Runtime role for ${serviceName} (${envCfg.name}). Reads the platform DB + shared alert-runner token; calls the gateway over Cloud Map.`,
    });

    // Cross-stack reads via addToPolicy only (never secret.grantRead /
    // key.grant*) so we don't mutate the upstream Secrets/KMS resource
    // policies and create a Secrets/Database -> Compute cycle. Same precedent
    // as createService above.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          secrets.appDbSecret.secretArn,
          secrets.alertRunnerServiceTokenSecret.secretArn,
        ],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    const executionRole = new iam.Role(this, `ExecRole-${serviceName}`, {
      roleName: `axira-${envCfg.name}-alert-runner-exec-role`,
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
        resources: [secrets.appKey.keyArn],
      }),
    );
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          secrets.appDbSecret.secretArn,
          secrets.alertRunnerServiceTokenSecret.secretArn,
        ],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(
      this,
      `TaskDef-${serviceName}`,
      {
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole,
        executionRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      },
    );

    const placeholder = envCfg.usePlaceholderImage;

    // Import cross-stack secrets so ecs.Secret.fromSecretsManager doesn't
    // mutate the upstream resource policy (addToPolicy on the roles above
    // already granted the reads).
    const importedAppDb = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      `Imp-${serviceName}-AppDb`,
      secrets.appDbSecret.secretArn,
    );
    const importedAlertRunnerToken =
      secretsmanager.Secret.fromSecretCompleteArn(
        this,
        `Imp-${serviceName}-Token`,
        secrets.alertRunnerServiceTokenSecret.secretArn,
      );

    taskDef.addContainer(serviceName, {
      image: placeholder
        ? ecs.ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest")
        : ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      essential: true,
      // Liveness port: the runner now runs a tiny health server (GET /health).
      // In placeholder mode nginx listens on :80, so map that instead.
      portMappings: [
        {
          containerPort: placeholder ? 80 : ALERT_RUNNER_HEALTH_PORT,
          protocol: ecs.Protocol.TCP,
        },
      ],
      environment: placeholder
        ? { PLACEHOLDER: "true" }
        : {
            NODE_ENV: envCfg.name === "genesis-prod" ? "production" : "staging",
            AXIRA_ENV: envCfg.name,
            AWS_REGION: this.region,
            LOG_LEVEL: "info",
            // Liveness server port (GET /health -> 200). Must equal
            // ALERT_RUNNER_HEALTH_PORT (the container portMapping + health check
            // below + the Cloud Map port) so the ops-plane collector can probe
            // alert-runner.axira.internal:<port>/health.
            RUNNER_HEALTH_PORT: String(ALERT_RUNNER_HEALTH_PORT),
            // In-cluster gateway URL the other platform services use
            // (GATEWAY_INTERNAL_URL). Same Cloud Map host/port the gateway
            // listens on.
            INTERNAL_GATEWAY_URL: GATEWAY_INTERNAL_URL,
            // DB connection parts, mirroring createService(): @axira/db's
            // ensureConnectionEnv() assembles DATABASE_URL from these at boot.
            DATABASE_HOST: database.auroraCluster.clusterEndpoint.hostname,
            DATABASE_PORT: "5432",
            DATABASE_NAME: "axira",
            DATABASE_READER_HOST: database.auroraReaderEndpoint,
            // Log SHIPPING — same unlock as the platform services (createService).
            // `createLogger()` tees this headless worker's logs into the LOGS
            // domain's axira-logs-* indices when OBS_OPENSEARCH_LOGS_URL is set;
            // unset == stdout-only. Unsigned best-effort /_bulk accepted by the
            // domain's open-in-VPC anonymous es:ESHttp* policy (the worker runs
            // on the ECS service SG, which the logs SG admits), so no IAM grant
            // is required. Parameterized per env, so genesis-prod is identical.
            OBS_OPENSEARCH_LOGS_URL: this.observability.logsDomainEndpoint,
          },
      secrets: placeholder
        ? undefined
        : {
            // Shared token: the SAME value the gateway validates as
            // ALERT_RUNNER_SERVICE_TOKEN (see createService → axira-gateway).
            // Plain-string secret, no JSON field.
            ALERT_RUNNER_SERVICE_TOKEN: ecs.Secret.fromSecretsManager(
              importedAlertRunnerToken,
            ),
            // DB creds from the SAME platform appDbSecret the gateway uses.
            DATABASE_USERNAME: ecs.Secret.fromSecretsManager(
              importedAppDb,
              "username",
            ),
            DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
              importedAppDb,
              "password",
            ),
          },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: serviceName, logGroup }),
      // NO ECS health check on the alert-runner. It is a leader-locked worker,
      // healthy whenever its process runs — there is no value in ECS killing it
      // over an HTTP probe. Adding one (probing the /health server) triggered the
      // ECS Deployment Circuit Breaker and rolled back the ENTIRE compute stack:
      // the alert-runner's CDK image tag is ":latest" (the roll job re-pins it to
      // :<sha> only AFTER cdk_finalize), and that :latest predates the health
      // server, so it never answered :3014 during the CDK deploy. The /health
      // server still ships in the :<sha> image for the ops-plane collector to
      // probe over the network — that does NOT require ECS to gate the task.
      // Do not re-add an ECS healthCheck here without first making the CDK image
      // track :<sha> (today only the post-cdk roll does that).
      healthCheck: undefined,
      stopTimeout: Duration.seconds(30),
      readonlyRootFilesystem: false,
    });

    const fargateService = new ecs.FargateService(this, `Svc-${serviceName}`, {
      cluster,
      taskDefinition: taskDef,
      serviceName: `axira-${envCfg.name}-alert-runner`,
      // Leader-locked scheduler: exactly one task (it self-elects via a
      // Postgres advisory lock, so 1 is the steady state).
      desiredCount: 1,
      assignPublicIp: false,
      securityGroups: [shared.serviceSg!],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: envCfg.name !== "genesis-prod",
      // Headless worker: allow the single task to drop to 0 during a deploy
      // rather than requiring 100% healthy (which a 1-task service can't keep).
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      // Register in Cloud Map so the runner (a) resolves gateway.axira.internal
      // inside the VPC and (b) is itself reachable at alert-runner.axira.internal
      // — the ops-plane infra-signal-collector probes
      // alert-runner.axira.internal:<ALERT_RUNNER_HEALTH_PORT>/health. An A-record
      // (task IP) is all the collector needs: it dials the port explicitly in the
      // URL, and the serviceSg self-ingress covers TCP 3000-3100 (NetworkStack),
      // so 3014 is reachable. The container `portMappings` above bind the port;
      // the discovery record only has to resolve the host.
      cloudMapOptions: {
        cloudMapNamespace: shared.serviceDiscoveryNamespace!,
        name: "alert-runner",
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
    });

    // DATABASE_URL is assembled at boot by ensureConnectionEnv() in the runner
    // entrypoint (apps/observability-alert-runner/src/index.ts) from the
    // DATABASE_HOST/PORT/NAME + DATABASE_USERNAME/DATABASE_PASSWORD parts
    // injected above — the same pattern as the gateway / agent-runtime /
    // workflow-engine services. No full-URL secret is needed.

    return fargateService;
  }

  private createDocsService(
    envCfg: EnvConfig,
    shared: SharedProps,
    cluster: ecs.ICluster,
    secrets: SecretsStack,
  ): ecs.FargateService {
    const docs = envCfg.docs;
    const serviceName = "axira-docs";
    const docsHost = `${docs.subdomain}.${envCfg.domainName}`;

    // Match the platform-service ECR policy: only prod envs (genesis-prod,
    // axira-los) retain. Staging envs destroy + emptyOnDelete so rollbacks
    // don't strand the repo.
    const isDev = !isProdEnv(envCfg.name);
    const repo = new ecr.Repository(this, `Repo-${serviceName}`, {
      repositoryName: `axira/${envCfg.name}/${serviceName}`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      lifecycleRules: [
        { maxImageCount: 30, rulePriority: 1, tagStatus: ecr.TagStatus.ANY },
      ],
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.imported.appKey,
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      emptyOnDelete: isDev,
    });
    this.repos[serviceName] = repo;

    const logGroup = new logs.LogGroup(this, `Logs-${serviceName}`, {
      logGroupName: `/axira/${envCfg.name}/${serviceName}`,
      retention: this.logRetentionFromDays(envCfg.retention.logRetentionDays),
      encryptionKey: this.imported.appKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskRole = new iam.Role(this, `TaskRole-${serviceName}`, {
      roleName: `axira-${envCfg.name}-docs-task-role`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: `Runtime role for ${serviceName} (${envCfg.name}). Read-only docs portal; no data-plane grants.`,
    });

    // Cross-stack KMS grants done via addToPolicy to avoid mutating the
    // key policy in SecretsStack (which would create a secrets -> compute
    // dependency and cycle through storage -> secrets via bucket KMS keys).
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    const executionRole = new iam.Role(this, `ExecRole-${serviceName}`, {
      roleName: `axira-${envCfg.name}-docs-exec-role`,
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
        resources: [secrets.appKey.keyArn],
      }),
    );

    const taskDef = new ecs.FargateTaskDefinition(
      this,
      `TaskDef-${serviceName}`,
      {
        cpu: docs.cpu,
        memoryLimitMiB: docs.memoryMiB,
        taskRole,
        executionRole,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
      },
    );

    // Mirror the same placeholder behavior as the platform services so the
    // docs portal also deploys before its image is built. Honors the
    // per-service override (docs pins itself to the placeholder until its image
    // pipeline exists).
    const placeholder = docs.usePlaceholderImage ?? envCfg.usePlaceholderImage;
    const effectivePort = placeholder ? 80 : docs.containerPort;

    taskDef.addContainer(serviceName, {
      image: placeholder
        ? ecs.ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:latest")
        : ecs.ContainerImage.fromEcrRepository(repo, "latest"),
      essential: true,
      portMappings: [
        { containerPort: effectivePort, protocol: ecs.Protocol.TCP },
      ],
      environment: placeholder
        ? { PLACEHOLDER: "true" }
        : {
            NODE_ENV: isProdEnv(envCfg.name) ? "production" : "staging",
            AXIRA_ENV: envCfg.name,
            AWS_REGION: this.region,
            PORT: String(docs.containerPort),
            DOCS_HOST: docsHost,
          },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: serviceName, logGroup }),
      healthCheck: placeholder
        ? undefined
        : {
            command: [
              "CMD-SHELL",
              `wget -q --spider http://localhost:${docs.containerPort}${docs.healthCheckPath} || exit 1`,
            ],
            interval: Duration.seconds(30),
            timeout: Duration.seconds(5),
            retries: 3,
            startPeriod: Duration.seconds(30),
          },
      stopTimeout: Duration.seconds(15),
      readonlyRootFilesystem: false,
    });

    const fargateService = new ecs.FargateService(this, `Svc-${serviceName}`, {
      cluster,
      taskDefinition: taskDef,
      serviceName: `axira-${envCfg.name}-docs`,
      desiredCount: docs.minTasks,
      assignPublicIp: false,
      securityGroups: [shared.serviceSg!],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: !isProdEnv(envCfg.name),
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const tg = new elbv2.ApplicationTargetGroup(this, `Tg-${serviceName}`, {
      // No explicit targetGroupName — same reason as the platform services:
      // a port-change replacement on a fixed name collides on create-before-delete.
      vpc: shared.vpc,
      port: effectivePort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      targets: [fargateService],
      healthCheck: {
        path: placeholder ? "/" : docs.healthCheckPath,
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        unhealthyThresholdCount: 3,
        healthyThresholdCount: 2,
      },
      deregistrationDelay: Duration.seconds(30),
    });
    this.targetGroups[serviceName] = tg;

    this.httpsListener.addAction(`Rule-${serviceName}`, {
      priority: docs.priority,
      conditions: [elbv2.ListenerCondition.hostHeaders([docsHost])],
      action: elbv2.ListenerAction.forward([tg]),
    });

    const scaling = fargateService.autoScaleTaskCount({
      minCapacity: docs.minTasks,
      maxCapacity: docs.maxTasks,
    });
    scaling.scaleOnCpuUtilization(`Cpu-${serviceName}`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(180),
      scaleOutCooldown: Duration.seconds(60),
    });

    new CfnOutput(this, "DocsHost", { value: docsHost });

    return fargateService;
  }

  private logRetentionFromDays(days: number): logs.RetentionDays {
    if (days <= 7) return logs.RetentionDays.ONE_WEEK;
    if (days <= 14) return logs.RetentionDays.TWO_WEEKS;
    if (days <= 30) return logs.RetentionDays.ONE_MONTH;
    if (days <= 60) return logs.RetentionDays.TWO_MONTHS;
    if (days <= 90) return logs.RetentionDays.THREE_MONTHS;
    return logs.RetentionDays.SIX_MONTHS;
  }
}
