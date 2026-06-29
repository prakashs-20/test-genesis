import {
  Stack,
  StackProps,
  RemovalPolicy,
  CfnOutput,
  Fn,
  Duration,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";

export interface OpsPlaneStackProps extends StackProps {
  readonly opsDomainName: string; // "ops.axiralabs.ai"
  readonly consoleDomainName: string; // "console.axiralabs.ai"
  /** "staging" | "production" - controls capacity, retention, deletion protection. */
  readonly envName?: "staging" | "production";
  /**
   * VPC CIDR for this plane env. The plane's staging + production both live
   * in the same Axira account, so each needs a distinct, non-overlapping
   * block. Defaults to the original 10.80.0.0/16 when omitted.
   */
  readonly vpcCidr?: string;
  /**
   * Customer gateway egress IPs (their NAT Elastic IPs), as CIDRs, that are the
   * ONLY sources allowed to reach the receiver (`ops.*`). The receiver stays
   * INTERNET-FACING but IP-locked: a WAFv2 IPSet allow-rule (WebACL default
   * action BLOCK) plus the public ALB security group (ingress :443 only from
   * these CIDRs) both gate it. The per-customer HMAC ingest token stays on top
   * as defense in depth. Defaults to `["0.0.0.0/32"]` (matches nothing →
   * fail-closed) when omitted; REPLACE with the real customer NAT EIPs.
   */
  readonly receiverAllowedCidrs?: readonly string[];
  /**
   * ARN of the Secrets Manager secret whose WHOLE value is the cloudflared
   * tunnel token for the CONSOLE connector. The console (`console.*`) is
   * WARP-private — no public ingress — reachable ONLY over this Cloudflare
   * Tunnel + WARP. The secret is created + seeded operationally (only the ARN
   * lives in config); imported via `fromSecretCompleteArn`. When omitted, the
   * cloudflared connector is not provisioned (console then has no reachable
   * path — useful only for a partial deploy).
   */
  readonly consoleTunnelTokenSecretArn?: string;
  /**
   * Container image tag pinned into every service task definition. The deploy
   * pipeline passes the exact build it validated in staging (`-c imageTag=<sha>`,
   * immutable ECR tags) so prod ships the bytes that were tested. Defaults to
   * "latest" for a manual/local synth.
   */
  readonly imageTag?: string;
  /**
   * Pre-created Route53 hosted-zone ID for opsDomainName. When set, the stack
   * IMPORTS the zone instead of creating it (stable + already NS-delegated in
   * Cloudflare) so deploys never churn nameservers or fail rollback on it.
   */
  readonly opsHostedZoneId?: string;
  /** Pre-created Route53 hosted-zone ID for consoleDomainName (import vs create). */
  readonly consoleHostedZoneId?: string;
}

/**
 * Axira-managed Ops Plane stack. Deployed to the Axira ops AWS account in us-west-2.
 *
 * Resources owned (Session 5.2):
 *   - Network: dedicated VPC (2 AZs, 1 NAT) - different account than the
 *     customer-cluster `infra/lib/network-stack.ts`, so no sharing.
 *   - Edge (split exposure as of the new access model, 2026-06-24):
 *       * Receiver (`ops.*`) - PUBLIC internet-facing ALB, but IP-LOCKED to the
 *         customer's gateway NAT EIPs via a WAFv2 IPSet allow-rule (WebACL
 *         default action BLOCK) AND the ALB SG (ingress :443 only from those
 *         CIDRs). Keeps the AWS managed rule sets (Common / KnownBadInputs /
 *         BotControl) + per-IP rate-limit. ACM cert via DNS validation.
 *       * Console (`console.*`) - WARP-PRIVATE on a SEPARATE internal-only ALB
 *         with NO public ingress: a `cloudflared` connector (ECS Fargate) dials
 *         OUT to Cloudflare and forwards WARP-routed traffic to the internal
 *         ALB, whose SG accepts ONLY the connector's SG on :3010. The console
 *         is reachable solely over the tunnel; its DNS is a Cloudflare DNS-only
 *         A record to the internal ALB's private IPs (set up out-of-band).
 *         Auth0 (`axiralabs-internal`) login stays on top.
 *   - Compute: ECS Fargate cluster + Fargate service running
 *     `apps/ops-plane-receiver` (`axira-ops/receiver` ECR repo). 2 task
 *     baseline, autoscale up to 10 on CPU>70%. Health check on /healthz.
 *     The same cluster also runs the console service and one headless
 *     worker - ops-incident-engine (no ALB, 1 task) - added to close the
 *     deploy gap (2026-06-24).
 *   - Storage: RDS Postgres 16 (db.t4g.small staging / db.r6g.large
 *     production, multi-AZ in production), ElastiCache Redis
 *     (cache.t4g.micro single-node staging, replicated cache.t4g.small
 *     in production), S3 bucket `axira-ops-events-archive-{env}` for
 *     a future Lambda+Firehose consumer.
 *   - Messaging: SNS topic `axira-ops-fanout` for Slack adapter / S3
 *     archiver / fleet sentinel subscribers (Sessions 5.4 / future).
 *   - Secrets: per-customer HMAC secrets are created lazily by the
 *     receiver's POST /admin/customers route; this stack only
 *     provisions the admin service-token secret
 *     (`axira-ops/service-token/admin`).
 *   - DNS: A record `ops.axiralabs.ai` → public receiver ALB. The console's
 *     DNS is a Cloudflare DNS-only A record → internal console ALB private IPs
 *     (managed out-of-band, NOT in this stack's Route53 zone).
 *   - Logging: `/axira/ops-plane-receiver` CloudWatch log group, 14d
 *     retention.
 *
 * Preserved from Session 0.2 (unchanged):
 *   - Route53 hosted zones for ops.axiralabs.ai + console.axiralabs.ai.
 *   - Fleet-sentinel Anthropic API key secret (ADR 0003).
 *
 * Reference:
 *   docs/ai-context/reference/service-ops-plane-receiver.md
 *   docs/ai-context/decisions/0008-receiver-rolls-its-own-migrations.md
 */
export class OpsPlaneStack extends Stack {
  // Session 0.2 surfaces - preserved unchanged.
  public readonly opsHostedZone: route53.IHostedZone;
  public readonly consoleHostedZone: route53.IHostedZone;
  public readonly fleetSentinelAnthropicSecret: secretsmanager.Secret;

  // Session 5.2 - receiver surfaces.
  public readonly receiverEndpoint: string;
  public readonly consoleEndpoint: string;
  public readonly rdsClusterArn: string;
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly receiverService: ecs.FargateService;
  public readonly receiverAlb: elbv2.ApplicationLoadBalancer;
  public readonly receiverCertificate: acm.Certificate;
  public readonly receiverDatabase: rds.DatabaseInstance;
  public readonly receiverDatabaseSecret: secretsmanager.Secret;
  public readonly receiverRedisEndpoint: string;
  public readonly fanoutTopic: sns.Topic;
  public readonly archiveBucket: s3.Bucket;
  public readonly serviceTokenSecret: secretsmanager.Secret;
  public readonly receiverLogGroup: logs.LogGroup;
  public readonly receiverTaskRole: iam.Role;
  // Session 5.4 - Slack adapter surfaces.
  public readonly slackQueue: sqs.Queue;
  public readonly slackDeadLetterQueue: sqs.Queue;
  public readonly slackBotTokenSecret: secretsmanager.Secret;
  public readonly slackSigningSecret: secretsmanager.Secret;
  // Session 5.5 - Axira Ops Console surfaces.
  public readonly consoleService: ecs.FargateService;
  public readonly consoleTaskRole: iam.Role;
  // New access model (2026-06-24) - console is WARP-private behind cloudflared.
  public readonly consoleAlb: elbv2.ApplicationLoadBalancer;
  public readonly cloudflaredService?: ecs.FargateService;
  public readonly consoleAuth0ClientId: secretsmanager.Secret;
  public readonly consoleAuth0ClientSecret: secretsmanager.Secret;
  public readonly consoleAuth0CookieSecret: secretsmanager.Secret;
  public readonly consoleDbCredentials: secretsmanager.Secret;
  public readonly consoleLogGroup: logs.LogGroup;
  // Session 6.2 - Runbook persister surfaces.
  public readonly runbookQueue: sqs.Queue;
  public readonly runbookDeadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: OpsPlaneStackProps) {
    super(scope, id, props);

    const env = props.envName ?? "staging";
    const isProd = env === "production";
    // Image tag for every service task def — pinned by the deploy pipeline to an
    // immutable :<sha>; "latest" only for a manual/local synth.
    const imageTag = props.imageTag ?? "latest";
    // Two-phase bring-up: `-c zeroServices=true` deploys every service at 0 tasks
    // so infra + cert + DB come up with nothing to crash-loop; a second deploy
    // without the flag scales them to real counts once DB + secrets are seeded.
    const zeroSvc =
      this.node.tryGetContext("zeroServices") === "true" ||
      this.node.tryGetContext("zeroServices") === true;
    const svc = (n: number): number => (zeroSvc ? 0 : n);

    // Customer gateway NAT EIP allow-list for the receiver. Defaults to a CIDR
    // that matches nothing (fail-closed) so an un-configured deploy exposes the
    // receiver to no one rather than to everyone. REPLACE with the real EIPs.
    const receiverAllowedCidrs =
      props.receiverAllowedCidrs && props.receiverAllowedCidrs.length > 0
        ? props.receiverAllowedCidrs
        : ["0.0.0.0/32"];

    // CloudFormation export names are unique per account+region. The plane's
    // staging + production stacks share one account+region, so every export
    // must carry the env to avoid a cross-stack collision on deploy.
    const exportPrefix = `AxiraOpsPlane-${env}-`;

    // ── Route53 hosted zones (Session 0.2 - preserved) ─────────────────
    // Import the zones when their IDs are supplied (stable, pre-delegated in
    // Cloudflare) so CFN never creates/deletes them — that churn produced new
    // nameservers each deploy + left ROLLBACK_FAILED on rollback (zones can't be
    // deleted while they hold the ACM validation records). Fall back to creating
    // them (and emitting the NS to delegate) when no ID is configured.
    this.opsHostedZone = props.opsHostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "OpsHostedZone", {
          hostedZoneId: props.opsHostedZoneId,
          zoneName: props.opsDomainName,
        })
      : new route53.HostedZone(this, "OpsHostedZone", {
          zoneName: props.opsDomainName,
          comment:
            "Hosts ops-plane-receiver records. Delegated from Cloudflare.",
        });
    if (!props.opsHostedZoneId) {
      new CfnOutput(this, "OpsHostedZoneNameServers", {
        value: Fn.join(
          ", ",
          (this.opsHostedZone as route53.HostedZone).hostedZoneNameServers!,
        ),
        description: `NS records to delegate in Cloudflare for ${props.opsDomainName}`,
        exportName: `${exportPrefix}OpsZoneNameServers`,
      });
    }

    this.consoleHostedZone = props.consoleHostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "ConsoleHostedZone", {
          hostedZoneId: props.consoleHostedZoneId,
          zoneName: props.consoleDomainName,
        })
      : new route53.HostedZone(this, "ConsoleHostedZone", {
          zoneName: props.consoleDomainName,
          comment:
            "Hosts axira-ops-console records. Delegated from Cloudflare.",
        });
    if (!props.consoleHostedZoneId) {
      new CfnOutput(this, "ConsoleHostedZoneNameServers", {
        value: Fn.join(
          ", ",
          (this.consoleHostedZone as route53.HostedZone).hostedZoneNameServers!,
        ),
        description: `NS records to delegate in Cloudflare for ${props.consoleDomainName}`,
        exportName: `${exportPrefix}ConsoleZoneNameServers`,
      });
    }

    // ── Fleet-sentinel Anthropic API key (Session 0.2 - preserved) ─────
    this.fleetSentinelAnthropicSecret = new secretsmanager.Secret(
      this,
      "FleetSentinelAnthropicSecret",
      {
        secretName: `axira-ops/${env}/fleet-sentinel/anthropic`,
        description:
          "Anthropic API key for axira-fleet-sentinel. Separate from customer-cluster key. ADR 0003.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );

    new CfnOutput(this, "FleetSentinelAnthropicSecretArn", {
      value: this.fleetSentinelAnthropicSecret.secretArn,
      description:
        "ARN of the fleet-sentinel Anthropic secret. Populate via `aws secretsmanager update-secret`.",
      exportName: `${exportPrefix}FleetSentinelAnthropicSecretArn`,
    });

    // ── Network (Session 5.2) ──────────────────────────────────────────
    this.vpc = new ec2.Vpc(this, "OpsVpc", {
      vpcName: `axira-ops-${env}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr ?? "10.80.0.0/16"),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Receiver ALB SG. The receiver stays internet-facing but IP-LOCKED: the
    // SG accepts :443/:80 ONLY from the customer gateway NAT EIPs (first layer;
    // the WAFv2 IPSet allow-rule below is the second). No `anyIpv4`.
    const albSecurityGroup = new ec2.SecurityGroup(this, "OpsAlbSg", {
      vpc: this.vpc,
      description:
        "Receiver ALB - accepts 443/80 ONLY from customer gateway NAT EIPs (ops.*)",
      allowAllOutbound: true,
    });
    for (const cidr of receiverAllowedCidrs) {
      albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(443),
        `HTTPS from customer NAT ${cidr}`,
      );
      albSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(80),
        `HTTP redirect from customer NAT ${cidr}`,
      );
    }

    const ecsSecurityGroup = new ec2.SecurityGroup(this, "OpsEcsSg", {
      vpc: this.vpc,
      description: "ECS tasks - accepts traffic from ops ALB",
      allowAllOutbound: true,
    });
    ecsSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(8080),
      "ALB to receiver task",
    );

    const dbSecurityGroup = new ec2.SecurityGroup(this, "OpsDbSg", {
      vpc: this.vpc,
      description: "RDS - accepts 5432 from ECS only",
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(5432),
      "ECS to RDS",
    );

    const redisSecurityGroup = new ec2.SecurityGroup(this, "OpsRedisSg", {
      vpc: this.vpc,
      description: "ElastiCache - accepts 6379 from ECS only",
      allowAllOutbound: false,
    });
    redisSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(6379),
      "ECS to Redis",
    );

    // ── ACM certificate for ops.axiralabs.ai (+ console SAN, Session 5.5) ─
    // One multi-SAN cert covers BOTH hosts. It is attached to the public
    // receiver ALB (terminates `ops.*`) AND the internal console ALB
    // (terminates `console.*`) — each ALB serves the host its listener routes,
    // and the cert is valid for both. DNS validation still runs against both
    // Route53 zones; the console's RUNTIME DNS is a separate Cloudflare
    // DNS-only record (out-of-band), independent of this validation.
    this.receiverCertificate = new acm.Certificate(this, "OpsCert", {
      domainName: props.opsDomainName,
      subjectAlternativeNames: [props.consoleDomainName],
      validation: acm.CertificateValidation.fromDnsMultiZone({
        [props.opsDomainName]: this.opsHostedZone,
        [props.consoleDomainName]: this.consoleHostedZone,
      }),
    });

    // ── Receiver ALB (PUBLIC, internet-facing, IP-locked by SG + WAF) ────
    // Serves ONLY `ops.*`. The console is no longer attached here (it moved to
    // its own internal ALB behind cloudflared — see the console section below).
    this.receiverAlb = new elbv2.ApplicationLoadBalancer(this, "OpsAlb", {
      loadBalancerName: `axira-ops-${env}-alb`,
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
    });

    const httpsListener = this.receiverAlb.addListener("OpsHttps", {
      port: 443,
      // `open: false` stops CDK auto-adding a 0.0.0.0/0 ingress for the listener
      // port. The IP lock lives entirely in `albSecurityGroup` (customer NAT
      // CIDRs only) + the WAF IPSet allow-rule; an open rule would defeat it.
      open: false,
      certificates: [this.receiverCertificate],
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        messageBody: "Not Found",
      }),
    });
    this.receiverAlb.addListener("OpsHttp", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: "HTTPS",
        port: "443",
        permanent: true,
      }),
    });

    // ── WAF (regional) — receiver IP allow-list + managed rules ──────────
    // New access model: the WebACL DEFAULTS TO BLOCK. A top-priority IPSet
    // allow-rule is the only thing that lets a request through, and it matches
    // ONLY the customer gateway NAT EIPs. This is the second enforcement layer
    // for the IP lock (the receiver ALB SG is the first). The existing AWS
    // managed rule sets (Common / KnownBadInputs / BotControl) + the per-IP
    // rate-limit are KEPT and run AFTER the allow-rule, so an allow-listed IP
    // is still subject to them (block actions there short-circuit the allow).
    const receiverIpSet = new wafv2.CfnIPSet(this, "OpsReceiverAllowIpSet", {
      name: `axira-ops-${env}-receiver-allow`,
      scope: "REGIONAL",
      ipAddressVersion: "IPV4",
      addresses: [...receiverAllowedCidrs],
      // NOTE: WAFv2 IPSet/WebACL descriptions reject ( ) and * — keep this
      // text within [\w +=:#@/.,-] + spaces only.
      description:
        "Customer gateway NAT EIPs allowed to reach the receiver ops endpoint. " +
        "Replace placeholders with the real /32 CIDRs.",
    });

    const webAcl = new wafv2.CfnWebACL(this, "OpsWaf", {
      name: `axira-ops-${env}-waf`,
      scope: "REGIONAL",
      // Default BLOCK — only the IPSet allow-rule below admits a request.
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `axira-ops-${env}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          // Top-priority ALLOW for the customer NAT EIPs. Everything else falls
          // through to the WebACL default action (BLOCK).
          name: "ReceiverIpAllowList",
          priority: 0,
          action: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "OpsReceiverIpAllowList",
            sampledRequestsEnabled: true,
          },
          statement: {
            ipSetReferenceStatement: { arn: receiverIpSet.attrArn },
          },
        },
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "OpsRateLimit",
            sampledRequestsEnabled: true,
          },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: "IP" },
          },
        },
        {
          name: "AWSManagedRulesCommon",
          priority: 2,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "OpsCommon",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
        },
        {
          name: "AWSManagedRulesBadInputs",
          priority: 3,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "OpsBadInputs",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
        },
        {
          name: "BotControl",
          priority: 4,
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "OpsBotControl",
            sampledRequestsEnabled: true,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesBotControlRuleSet",
            },
          },
        },
      ],
    });

    // This association attaches the WebACL to the RECEIVER ALB only. The
    // console's internal ALB is sealed by its SG (cloudflared-only) and has no
    // public path, so it needs no WAF.
    new wafv2.CfnWebACLAssociation(this, "OpsWafAlbAssociation", {
      resourceArn: this.receiverAlb.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });

    // ── Route53 A record ───────────────────────────────────────────────
    new route53.ARecord(this, "OpsAliasRecord", {
      zone: this.opsHostedZone,
      recordName: props.opsDomainName,
      target: route53.RecordTarget.fromAlias(
        new targets.LoadBalancerTarget(this.receiverAlb),
      ),
    });

    // ── RDS Postgres ───────────────────────────────────────────────────
    this.receiverDatabaseSecret = new secretsmanager.Secret(
      this,
      "OpsDbCredentials",
      {
        secretName: `axira-ops/${env}/rds/credentials`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: "axira_ops_admin" }),
          generateStringKey: "password",
          excludePunctuation: true,
          passwordLength: 32,
        },
      },
    );

    const dbParameterGroup = new rds.ParameterGroup(this, "OpsDbParams", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      parameters: {
        log_min_duration_statement: "1000",
        max_connections: "200",
        // RDS Postgres 16 defaults rds.force_ssl=1 (rejects plaintext), but the
        // ops apps' postgres driver connects without TLS → the receiver's first
        // migration query failed. The DB lives in isolated VPC subnets, so allow
        // plaintext for now. FOLLOW-UP: set the driver to sslmode=require and
        // restore force_ssl=1.
        "rds.force_ssl": "0",
      },
    });

    this.receiverDatabase = new rds.DatabaseInstance(this, "OpsDb", {
      instanceIdentifier: `axira-ops-${env}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: isProd
        ? ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.LARGE)
        : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.receiverDatabaseSecret),
      databaseName: "axira_ops",
      multiAz: isProd,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(isProd ? 14 : 7),
      deletionProtection: isProd,
      parameterGroup: dbParameterGroup,
      monitoringInterval: Duration.seconds(60),
      enablePerformanceInsights: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.rdsClusterArn = this.receiverDatabase.instanceArn;

    // OPS_DB_URL is assembled at container start: the password is a secret env
    // (OPS_DB_PASSWORD), the rest plain env. The receiver + incident images read
    // OPS_DB_URL as one connection string, but ECS can't interpolate a secret
    // into a partial env var — so a tiny sh wrapper builds the URL then execs
    // the app. The RDS password excludes punctuation (URL-safe → no encoding).
    const dbConnEnv: Record<string, string> = {
      OPS_DB_HOST: this.receiverDatabase.dbInstanceEndpointAddress,
      OPS_DB_PORT: this.receiverDatabase.dbInstanceEndpointPort,
      OPS_DB_USER: "axira_ops_admin",
      OPS_DB_NAME: "axira_ops",
    };
    const dbPasswordSecret = {
      OPS_DB_PASSWORD: ecs.Secret.fromSecretsManager(
        this.receiverDatabaseSecret,
        "password",
      ),
    };
    const withAssembledDbUrl = (appEntry: string): string[] => [
      "sh",
      "-c",
      `export OPS_DB_URL="postgresql://\${OPS_DB_USER}:\${OPS_DB_PASSWORD}@\${OPS_DB_HOST}:\${OPS_DB_PORT}/\${OPS_DB_NAME}"; exec ${appEntry}`,
    ];

    // ── ElastiCache Redis ──────────────────────────────────────────────
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "OpsRedisSubnetGroup",
      {
        description: `Axira ops-plane ${env} Redis subnet group`,
        subnetIds: this.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
        cacheSubnetGroupName: `axira-ops-${env}-redis`,
      },
    );

    if (isProd) {
      const redisCluster = new elasticache.CfnReplicationGroup(
        this,
        "OpsRedisReplication",
        {
          replicationGroupDescription: `Axira ops-plane ${env} Redis cluster`,
          engine: "redis",
          engineVersion: "7.1",
          cacheNodeType: "cache.t4g.small",
          numCacheClusters: 2,
          automaticFailoverEnabled: true,
          multiAzEnabled: true,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName!,
          securityGroupIds: [redisSecurityGroup.securityGroupId],
          atRestEncryptionEnabled: true,
          transitEncryptionEnabled: true,
        },
      );
      this.receiverRedisEndpoint = redisCluster.attrPrimaryEndPointAddress;
    } else {
      const redisCluster = new elasticache.CfnCacheCluster(
        this,
        "OpsRedisCluster",
        {
          clusterName: `axira-ops-${env}-redis`,
          engine: "redis",
          engineVersion: "7.1",
          cacheNodeType: "cache.t4g.micro",
          numCacheNodes: 1,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName!,
          vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
        },
      );
      this.receiverRedisEndpoint = redisCluster.attrRedisEndpointAddress;
    }

    // ── SNS fanout topic ───────────────────────────────────────────────
    this.fanoutTopic = new sns.Topic(this, "OpsFanoutTopic", {
      topicName: `axira-ops-fanout-${env}`,
      displayName: "Axira Ops Events Fanout",
      masterKey: undefined, // KMS-managed key applied below for at-rest encryption
      enforceSSL: true,
    });
    // Use AWS-managed KMS for at-rest encryption (no customer-managed key
    // overhead in 5.2; can swap to a CMK in a future hardening pass).
    (this.fanoutTopic.node.defaultChild as sns.CfnTopic).kmsMasterKeyId =
      "alias/aws/sns";

    // ── S3 archive bucket (declared; consumer ships in a future session) ─
    this.archiveBucket = new s3.Bucket(this, "OpsEventsArchive", {
      bucketName: `axira-ops-events-archive-${env}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          id: "archive-tier",
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: Duration.days(90),
            },
          ],
          expiration: Duration.days(730),
        },
      ],
    });

    // ── Service-token secret for admin routes ──────────────────────────
    this.serviceTokenSecret = new secretsmanager.Secret(
      this,
      "OpsServiceToken",
      {
        secretName: `axira-ops/${env}/service-token/admin`,
        description:
          "Admin service token for POST /admin/customers. Rotate manually until 5.5 Auth0 path ships.",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true,
        },
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );

    // ── Slack adapter secrets (Session 5.4) ────────────────────────────
    // Both secrets are declared empty by CDK; values are populated
    // out-of-band via `aws secretsmanager update-secret` per the
    // Slack workspace setup in the onboarding playbook.
    this.slackBotTokenSecret = new secretsmanager.Secret(
      this,
      "SlackBotTokenSecret",
      {
        secretName: `axira-ops/${env}/slack/bot-token`,
        description:
          "Slack bot token for the axira-ops Slack adapter. Populate out-of-band; do not commit a value.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );
    this.slackSigningSecret = new secretsmanager.Secret(
      this,
      "SlackSigningSecret",
      {
        secretName: `axira-ops/${env}/slack/signing-secret`,
        description:
          "Slack signing secret for /v1/callbacks/ack signature verification. Populate out-of-band.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );

    new CfnOutput(this, "SlackBotTokenSecretArn", {
      value: this.slackBotTokenSecret.secretArn,
      description: `Populate via: aws secretsmanager update-secret --secret-id axira-ops/${env}/slack/bot-token --secret-string xoxb-…`,
      exportName: `${exportPrefix}SlackBotTokenSecretArn`,
    });

    new CfnOutput(this, "SlackSigningSecretArn", {
      value: this.slackSigningSecret.secretArn,
      description: `Populate via: aws secretsmanager update-secret --secret-id axira-ops/${env}/slack/signing-secret --secret-string …`,
      exportName: `${exportPrefix}SlackSigningSecretArn`,
    });

    // ── Slack adapter SQS queue + DLQ + SNS subscription (Session 5.4) ─
    this.slackDeadLetterQueue = new sqs.Queue(this, "SlackDLQ", {
      queueName: `axira-ops-slack-dlq-${env}`,
      retentionPeriod: Duration.days(14),
    });

    this.slackQueue = new sqs.Queue(this, "SlackQueue", {
      queueName: `axira-ops-slack-queue-${env}`,
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.slackDeadLetterQueue,
        maxReceiveCount: 5,
      },
    });

    // Subscribe the queue to the existing fanout topic with a
    // kind-allowlist filter - only the 9 in-scope event kinds are
    // delivered. Heartbeats / drift / budget / guardrail events are
    // intentionally dropped at the SNS layer to avoid pulling traffic
    // we'd just no-op on.
    //
    // Session 6.1 added `runbook.drafted` - sentinel-drafted triage
    // hypotheses posted as thread replies under the parent
    // alert.fired root.
    this.fanoutTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.slackQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          kind: sns.SubscriptionFilter.stringFilter({
            allowlist: [
              "alert.fired",
              "alert.resolved",
              "alert.acknowledged",
              "alert.escalated",
              "service.unhealthy",
              "service.recovered",
              "deployment.rolled_back",
              "capability.cert_failed",
              "runbook.drafted",
            ],
          }),
        },
      }),
    );

    new CfnOutput(this, "SlackQueueUrl", {
      value: this.slackQueue.queueUrl,
      description:
        "Slack adapter SQS queue URL - passed to the receiver as SLACK_QUEUE_URL",
      exportName: `${exportPrefix}SlackQueueUrl`,
    });

    // ── Runbook persister SQS queue + DLQ + SNS subscription (6.2) ─────
    //
    // Same shape as the slack queue - 14d DLQ retention, 30s
    // visibility, maxReceiveCount=5 before DLQ. SNS filter policy
    // restricts to `runbook.drafted` ONLY; other ops events go through
    // the slack queue (or are dropped by SNS).
    this.runbookDeadLetterQueue = new sqs.Queue(this, "RunbookDLQ", {
      queueName: `axira-ops-runbook-dlq-${env}`,
      retentionPeriod: Duration.days(14),
    });

    this.runbookQueue = new sqs.Queue(this, "RunbookQueue", {
      queueName: `axira-ops-runbook-queue-${env}`,
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.runbookDeadLetterQueue,
        maxReceiveCount: 5,
      },
    });

    this.fanoutTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(this.runbookQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          kind: sns.SubscriptionFilter.stringFilter({
            allowlist: ["runbook.drafted"],
          }),
        },
      }),
    );

    new CfnOutput(this, "RunbookQueueUrl", {
      value: this.runbookQueue.queueUrl,
      description:
        "Runbook persister SQS queue URL - passed to the receiver as RUNBOOK_QUEUE_URL",
      exportName: `${exportPrefix}RunbookQueueUrl`,
    });

    // ── CloudWatch log group ───────────────────────────────────────────
    this.receiverLogGroup = new logs.LogGroup(this, "OpsReceiverLogs", {
      logGroupName: `/axira/ops/${env}/ops-plane-receiver`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // ── ECS cluster + Fargate service ──────────────────────────────────
    this.cluster = new ecs.Cluster(this, "OpsCluster", {
      clusterName: `axira-ops-${env}`,
      vpc: this.vpc,
      containerInsights: true,
    });

    this.receiverTaskRole = new iam.Role(this, "OpsReceiverTaskRole", {
      roleName: `axira-ops-${env}-receiver-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Task role for axira-ops/receiver Fargate tasks",
    });

    // Permissions: read axira-ops/* secrets, publish to fanout, write
    // archive bucket, write CloudWatch logs.
    this.receiverTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOpsSecrets",
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira-ops/${env}/*`,
        ],
      }),
    );
    this.receiverTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "CreateCustomerHmacSecrets",
        actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira-ops/${env}/customer/*`,
        ],
      }),
    );
    this.fanoutTopic.grantPublish(this.receiverTaskRole);
    this.archiveBucket.grantWrite(this.receiverTaskRole);
    this.receiverLogGroup.grantWrite(this.receiverTaskRole);
    // Session 5.4 - Slack adapter grants. The receiver consumes from
    // the slack queue and reads both Slack secrets at boot.
    this.slackQueue.grantConsumeMessages(this.receiverTaskRole);
    this.slackBotTokenSecret.grantRead(this.receiverTaskRole);
    this.slackSigningSecret.grantRead(this.receiverTaskRole);
    // Session 6.2 - runbook persister consumes from the runbook
    // queue. No secret reads needed (the persister writes only to
    // the receiver's own RDS; the runbook ops events are already
    // signed + verified upstream by the receiver's ingest path).
    this.runbookQueue.grantConsumeMessages(this.receiverTaskRole);

    const receiverTaskDef = new ecs.FargateTaskDefinition(
      this,
      "OpsReceiverTaskDef",
      {
        cpu: isProd ? 2048 : 512,
        memoryLimitMiB: isProd ? 4096 : 1024,
        family: `axira-ops-${env}-receiver`,
        taskRole: this.receiverTaskRole,
      },
    );

    receiverTaskDef.addContainer("app", {
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(
          this,
          "OpsReceiverRepo",
          `axira-ops/receiver-${env}`,
        ),
        imageTag,
      ),
      environment: {
        NODE_ENV: env,
        PORT: "8080",
        HOST: "0.0.0.0",
        AWS_REGION: this.region,
        OPS_SNS_FANOUT_TOPIC_ARN: this.fanoutTopic.topicArn,
        OPS_SECRETS_PREFIX: `axira-ops/${env}`,
        OPS_SERVICE_TOKEN_SECRET_ARN: this.serviceTokenSecret.secretArn,
        OPS_REDIS_URL: `redis://${this.receiverRedisEndpoint}:6379`,
        OPS_NONCE_TTL_SECONDS: "600",
        OPS_TIMESTAMP_WINDOW_SECONDS: "300",
        OPS_CUSTOMER_SECRET_CACHE_TTL_MS: "300000",
        OPS_DEFAULT_RATE_LIMIT_PER_MIN: "1000",
        OPS_RUN_MIGRATIONS_ON_STARTUP: "true",
        // Session 5.4 - Slack adapter runtime wiring.
        SLACK_ADAPTER_ENABLED: "true",
        SLACK_QUEUE_URL: this.slackQueue.queueUrl,
        SLACK_BOT_TOKEN_REF: this.slackBotTokenSecret.secretArn,
        SLACK_SIGNING_SECRET_REF: this.slackSigningSecret.secretArn,
        // Session 6.2 - Runbook persister runtime wiring.
        RUNBOOK_PERSISTER_ENABLED: "true",
        RUNBOOK_QUEUE_URL: this.runbookQueue.queueUrl,
        LOG_LEVEL: "info",
        ...dbConnEnv,
      },
      secrets: { ...dbPasswordSecret },
      command: withAssembledDbUrl("node apps/ops-plane-receiver/dist/index.js"),
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "receiver",
        logGroup: this.receiverLogGroup,
      }),
      // No container-level health check: the receiver's slim node runtime image
      // ships no curl, so `curl -f .../readyz` silently failed ("not found" ->
      // non-zero) and ECS reaped the task ~2min in, gently flapping (1->2->1)
      // and permanently stalling CFN's service stabilization. The ALB target
      // group health check (OpsReceiverTargetGroup -> /readyz, below) is the
      // authoritative health signal for routing AND ECS deployment stability.
    });

    this.receiverService = new ecs.FargateService(this, "OpsReceiverService", {
      cluster: this.cluster,
      taskDefinition: receiverTaskDef,
      desiredCount: svc(2),
      securityGroups: [ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    this.receiverDatabase.connections.allowDefaultPortFrom(
      this.receiverService,
    );

    const receiverTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "OpsReceiverTargetGroup",
      {
        vpc: this.vpc,
        port: 8080,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.receiverService],
        healthCheck: {
          // Shallow liveness for the LB gate. /healthz is a DEEP probe
          // (DB+Redis+SNS+self-monitor) that returns 503/"degraded" on optional
          // deps (e.g. a placeholder Slack token), which would wrongly
          // deregister a serving task. /readyz = "process up + serving"; the
          // deep probe stays available for monitoring.
          path: "/readyz",
          interval: Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: "200",
        },
      },
    );

    httpsListener.addTargetGroups("OpsReceiverRoute", {
      targetGroups: [receiverTargetGroup],
      priority: 10,
      // ALB allows at most 5 condition VALUES per rule (across all conditions).
      // The receiver ALB is dedicated + IP-locked (SG + WAF), so host-header
      // matching is redundant — drop it and keep the 5 path patterns (= 5).
      conditions: [
        elbv2.ListenerCondition.pathPatterns([
          "/v1/events",
          "/v1/callbacks/*",
          "/admin/*",
          "/healthz",
          "/readyz",
        ]),
      ],
    });

    const scaling = this.receiverService.autoScaleTaskCount({
      minCapacity: svc(2),
      maxCapacity: 10,
    });
    scaling.scaleOnCpuUtilization("OpsReceiverCpuScaling", {
      targetUtilizationPercent: 70,
      scaleInCooldown: Duration.seconds(300),
      scaleOutCooldown: Duration.seconds(60),
    });

    this.receiverEndpoint = `https://${props.opsDomainName}`;

    // ─── Axira Ops Console (Session 5.5; WARP-private as of 2026-06-24) ──
    //
    // Runs in the same cluster as the receiver but is WARP-PRIVATE: it sits
    // behind its OWN internal-only ALB (NOT the public receiver ALB), reached
    // solely via the cloudflared connector below. It has its own task
    // definition, IAM role, and target group, keyed on the
    // `console.axiralabs.ai` host header. The console reads the receiver's RDS
    // via a dedicated read-only role (provisioned out-of-band per the playbook
    // + populated into the `ConsoleDbCredentials` Secrets Manager entry).

    this.consoleAuth0ClientId = new secretsmanager.Secret(
      this,
      "ConsoleAuth0ClientId",
      {
        secretName: `axira-ops/${env}/console/auth0-client-id`,
        description:
          "Auth0 application client_id for axiralabs-internal tenant. Populated out-of-band.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );
    this.consoleAuth0ClientSecret = new secretsmanager.Secret(
      this,
      "ConsoleAuth0ClientSecret",
      {
        secretName: `axira-ops/${env}/console/auth0-client-secret`,
        description: "Auth0 application client_secret. Populated out-of-band.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );
    this.consoleAuth0CookieSecret = new secretsmanager.Secret(
      this,
      "ConsoleAuth0CookieSecret",
      {
        secretName: `axira-ops/${env}/console/auth0-cookie-secret`,
        description:
          "32-byte random value used by @auth0/nextjs-auth0 to encrypt session cookies.",
        generateSecretString: {
          passwordLength: 64,
          excludePunctuation: true,
        },
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );
    this.consoleDbCredentials = new secretsmanager.Secret(
      this,
      "ConsoleDbCredentials",
      {
        secretName: `axira-ops/${env}/console/db-credentials`,
        description:
          "Read-only Postgres URL for the axira_ops_console role. Populate with " +
          "`postgres://axira_ops_console:<pwd>@<host>:5432/axira_ops` after running " +
          "the role-bootstrap playbook on the receiver RDS.",
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );

    this.consoleLogGroup = new logs.LogGroup(this, "ConsoleLogGroup", {
      logGroupName: `/axira/ops/${env}/console`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.consoleTaskRole = new iam.Role(this, "ConsoleTaskRole", {
      roleName: `axira-ops-${env}-console-task`,
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Task role for axira-ops-console Fargate tasks.",
    });
    // The console reads its own Auth0 + DB secrets, plus the receiver
    // service token so write proxies can authenticate to /admin/*.
    this.consoleAuth0ClientId.grantRead(this.consoleTaskRole);
    this.consoleAuth0ClientSecret.grantRead(this.consoleTaskRole);
    this.consoleAuth0CookieSecret.grantRead(this.consoleTaskRole);
    this.consoleDbCredentials.grantRead(this.consoleTaskRole);
    this.serviceTokenSecret.grantRead(this.consoleTaskRole);
    this.consoleLogGroup.grantWrite(this.consoleTaskRole);

    // ── Console isolation SGs (WARP-private behind cloudflared) ──────────
    // Chain: cloudflared connector SG → internal console ALB SG :443 →
    // console task SG :3010. Each link accepts ONLY the SG before it, so the
    // console has NO public path — it is reachable solely over the tunnel.
    //
    // cloudflaredSecurityGroup: the connector dials OUT to Cloudflare; no
    // inbound rules at all (outbound-only). It is the ONLY source the console
    // ALB SG admits.
    const cloudflaredSecurityGroup = new ec2.SecurityGroup(
      this,
      "OpsCloudflaredSg",
      {
        vpc: this.vpc,
        description:
          "cloudflared connector for console.* (outbound-only to Cloudflare)",
        allowAllOutbound: true,
      },
    );

    // consoleAlbSecurityGroup: the INTERNAL console ALB. Accepts :443 ONLY from
    // the cloudflared connector — no internet, no other peer.
    const consoleAlbSecurityGroup = new ec2.SecurityGroup(
      this,
      "OpsConsoleAlbSg",
      {
        vpc: this.vpc,
        description:
          "Internal console ALB - accepts 443 ONLY from the cloudflared connector",
        allowAllOutbound: true,
      },
    );
    consoleAlbSecurityGroup.addIngressRule(
      cloudflaredSecurityGroup,
      ec2.Port.tcp(443),
      "cloudflared tunnel to console ALB (HTTPS)",
    );

    // consoleSecurityGroup: the console Fargate tasks. Accept :3010 ONLY from
    // the internal console ALB SG (NOT the public receiver ALB SG anymore).
    const consoleSecurityGroup = new ec2.SecurityGroup(this, "OpsConsoleSg", {
      vpc: this.vpc,
      description:
        "Console Fargate tasks - accept traffic ONLY from the internal console ALB on 3010",
      allowAllOutbound: true,
    });
    consoleSecurityGroup.addIngressRule(
      consoleAlbSecurityGroup,
      ec2.Port.tcp(3010),
      "Internal console ALB to console task",
    );
    // Console reuses the existing dbSecurityGroup ingress for ECS;
    // also allow this new SG outbound to RDS via a sibling rule.
    dbSecurityGroup.addIngressRule(
      consoleSecurityGroup,
      ec2.Port.tcp(5432),
      "Console to RDS (read-only)",
    );

    const consoleTaskDef = new ecs.FargateTaskDefinition(
      this,
      "ConsoleTaskDef",
      {
        cpu: isProd ? 1024 : 512,
        memoryLimitMiB: isProd ? 2048 : 1024,
        family: `axira-ops-${env}-console`,
        taskRole: this.consoleTaskRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      },
    );

    consoleTaskDef.addContainer("app", {
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(
          this,
          "ConsoleRepo",
          `axira-ops/console-${env}`,
        ),
        imageTag,
      ),
      environment: {
        NODE_ENV: env,
        PORT: "3010",
        HOST: "0.0.0.0",
        AWS_REGION: this.region,
        AUTH0_BASE_URL: `https://${props.consoleDomainName}`,
        AUTH0_ISSUER_BASE_URL: "https://axiralabs-internal.us.auth0.com",
        AXIRA_OPS_RECEIVER_URL: `https://${props.opsDomainName}`,
        AXIRA_OPS_SERVICE_TOKEN_REF: this.serviceTokenSecret.secretArn,
        LOG_LEVEL: "info",
      },
      secrets: {
        AUTH0_CLIENT_ID: ecs.Secret.fromSecretsManager(
          this.consoleAuth0ClientId,
        ),
        AUTH0_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
          this.consoleAuth0ClientSecret,
        ),
        AUTH0_SECRET: ecs.Secret.fromSecretsManager(
          this.consoleAuth0CookieSecret,
        ),
        DATABASE_URL: ecs.Secret.fromSecretsManager(this.consoleDbCredentials),
      },
      portMappings: [{ containerPort: 3010, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "console",
        logGroup: this.consoleLogGroup,
      }),
      // No container-level health check: the Next.js standalone runtime image
      // ships no shell HTTP client (wget/curl absent) and `node -e` was also
      // unreliable in the health-check exec context — every variant silently
      // failed, so ECS reaped the task ~2min in and stalled the CFN deploy.
      // The ALB target group health check (ConsoleTargetGroup -> /api/health,
      // below) is authoritative for routing AND for ECS deployment stability
      // (a task must pass the ELB check to count as healthy). That is the
      // correct single source of truth for a web app behind a load balancer.
    });

    this.consoleService = new ecs.FargateService(this, "ConsoleService", {
      cluster: this.cluster,
      taskDefinition: consoleTaskDef,
      desiredCount: svc(isProd ? 2 : 1),
      securityGroups: [consoleSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // ── Internal console ALB (NO public ingress) ────────────────────────
    // `internetFacing: false` places this ALB in the PRIVATE_WITH_EGRESS
    // subnets with only private IPs. Its SG admits :443 ONLY from the
    // cloudflared connector, so the sole route to the console is the tunnel.
    // It terminates HTTPS with the same multi-SAN cert (valid for console.*).
    this.consoleAlb = new elbv2.ApplicationLoadBalancer(this, "OpsConsoleAlb", {
      loadBalancerName: `axira-ops-${env}-console-alb`,
      vpc: this.vpc,
      internetFacing: false,
      securityGroup: consoleAlbSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const consoleHttpsListener = this.consoleAlb.addListener(
      "OpsConsoleHttps",
      {
        port: 443,
        // `open: false` — CRITICAL. Without it CDK adds a 0.0.0.0/0 ingress on
        // :443, which would punch through the WARP-private isolation. The ONLY
        // admitted source is the cloudflared connector SG (added above).
        open: false,
        certificates: [this.receiverCertificate],
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          messageBody: "Not Found",
        }),
      },
    );

    const consoleTargetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "ConsoleTargetGroup",
      {
        vpc: this.vpc,
        port: 3010,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targets: [this.consoleService],
        healthCheck: {
          path: "/api/health",
          interval: Duration.seconds(30),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
          healthyHttpCodes: "200",
        },
      },
    );

    consoleHttpsListener.addTargetGroups("ConsoleRoute", {
      targetGroups: [consoleTargetGroup],
      priority: 20,
      conditions: [
        elbv2.ListenerCondition.hostHeaders([props.consoleDomainName]),
      ],
    });

    // NOTE: no Route53 alias to a public ALB anymore. The console's runtime DNS
    // is a Cloudflare DNS-only (grey-cloud) A record → this internal ALB's
    // PRIVATE IPs, resolvable only from a WARP-enrolled device. That record is
    // managed OUT-OF-BAND (Cloudflare), not in this stack's Route53 zone. The
    // ConsoleHostedZone is retained for the ACM DNS validation of the SAN only.

    // ── cloudflared connector for the console (WARP-private edge) ────────
    // A single ECS Fargate task runs `cloudflared tunnel run`, dials OUT to
    // Cloudflare (no inbound ports), and forwards WARP-routed traffic to the
    // internal console ALB. Request path:
    //   browser (WARP) → Cloudflare → tunnel → cloudflared → console ALB :443 → console
    // The token is read from Secrets Manager by ARN (value seeded out-of-band).
    // Only provisioned when a token ARN is supplied.
    if (props.consoleTunnelTokenSecretArn) {
      const cloudflaredLogGroup = new logs.LogGroup(
        this,
        "OpsCloudflaredLogs",
        {
          logGroupName: `/axira/ops/${env}/cloudflared`,
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        },
      );

      // Import by EXACT ARN so the ECS `valueFrom` is a concrete secret ARN
      // (fromSecretNameV2 yields a `-??????` wildcard ARN ECS rejects).
      const consoleTunnelToken = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "OpsConsoleTunnelToken",
        props.consoleTunnelTokenSecretArn,
      );

      const cloudflaredExecRole = new iam.Role(this, "OpsCloudflaredExecRole", {
        roleName: `axira-ops-${env}-cloudflared-exec`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AmazonECSTaskExecutionRolePolicy",
          ),
        ],
      });
      consoleTunnelToken.grantRead(cloudflaredExecRole);

      const cloudflaredTaskDef = new ecs.FargateTaskDefinition(
        this,
        "OpsCloudflaredTaskDef",
        {
          family: `axira-ops-${env}-cloudflared`,
          cpu: 256,
          memoryLimitMiB: 512,
          executionRole: cloudflaredExecRole,
          runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64 },
        },
      );

      cloudflaredTaskDef.addContainer("cloudflared", {
        image: ecs.ContainerImage.fromRegistry("cloudflare/cloudflared:latest"),
        essential: true,
        // `run` with no tunnel arg uses TUNNEL_TOKEN to resolve the tunnel + its
        // remote-managed config (the public-hostname/ingress route to the
        // console ALB). --metrics exposes a local readiness endpoint on :2000.
        command: [
          "tunnel",
          "--no-autoupdate",
          "--metrics",
          "0.0.0.0:2000",
          "run",
        ],
        secrets: {
          // Whole-secret value is the token (no JSON field).
          TUNNEL_TOKEN: ecs.Secret.fromSecretsManager(consoleTunnelToken),
        },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: "cloudflared",
          logGroup: cloudflaredLogGroup,
        }),
        stopTimeout: Duration.seconds(30),
        readonlyRootFilesystem: false,
      });

      this.cloudflaredService = new ecs.FargateService(
        this,
        "OpsCloudflaredService",
        {
          cluster: this.cluster,
          taskDefinition: cloudflaredTaskDef,
          serviceName: `axira-ops-${env}-cloudflared`,
          desiredCount: svc(1),
          assignPublicIp: false,
          securityGroups: [cloudflaredSecurityGroup],
          vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
          circuitBreaker: { rollback: true },
          minHealthyPercent: 0,
          maxHealthyPercent: 200,
        },
      );

      new CfnOutput(this, "OpsCloudflaredServiceName", {
        value: this.cloudflaredService.serviceName,
        description: `cloudflared tunnel connector for ${props.consoleDomainName} (WARP-private)`,
        exportName: `${exportPrefix}CloudflaredService`,
      });
    }

    this.consoleEndpoint = `https://${props.consoleDomainName}`;

    new CfnOutput(this, "ConsoleEndpoint", {
      value: this.consoleEndpoint,
      description:
        "WARP-private HTTPS endpoint for the axira-ops-console (resolvable only on WARP via a Cloudflare DNS-only record to the internal ALB)",
      exportName: `${exportPrefix}ConsoleEndpoint`,
    });

    new CfnOutput(this, "ConsoleInternalAlbDnsName", {
      value: this.consoleAlb.loadBalancerDnsName,
      description:
        "Internal console ALB DNS name. Resolve to its PRIVATE IPs and create a Cloudflare DNS-only A record for the console host pointing at them (out-of-band).",
      exportName: `${exportPrefix}ConsoleInternalAlbDnsName`,
    });

    new CfnOutput(this, "ConsoleAuth0ClientIdArn", {
      value: this.consoleAuth0ClientId.secretArn,
      description: `Populate via aws secretsmanager update-secret --secret-id axira-ops/${env}/console/auth0-client-id --secret-string …`,
      exportName: `${exportPrefix}ConsoleAuth0ClientIdArn`,
    });

    new CfnOutput(this, "ConsoleAuth0ClientSecretArn", {
      value: this.consoleAuth0ClientSecret.secretArn,
      description: `Populate via aws secretsmanager update-secret --secret-id axira-ops/${env}/console/auth0-client-secret --secret-string …`,
      exportName: `${exportPrefix}ConsoleAuth0ClientSecretArn`,
    });

    new CfnOutput(this, "ConsoleDbCredentialsArn", {
      value: this.consoleDbCredentials.secretArn,
      description:
        "Populate after running the read-only-role bootstrap migration; expects a Postgres URL string.",
      exportName: `${exportPrefix}ConsoleDbCredentialsArn`,
    });

    // ─────────────────────────────────────────────────────────────────────
    // Headless worker services (close the ops-plane CDK gap, 2026-06-24)
    //
    // ops-incident-engine is a long-running worker — NO HTTP port, NO ALB
    // target. It runs in the same cluster + private subnets as the
    // receiver/console. Build + push its image to the
    // axira-ops/incident-engine-<env> ECR repo before deploy (same as the
    // receiver).
    // ─────────────────────────────────────────────────────────────────────

    const workerSecurityGroup = new ec2.SecurityGroup(this, "OpsWorkerSg", {
      vpc: this.vpc,
      description: "Ops-plane headless workers (incident-engine). Egress-only.",
      allowAllOutbound: true,
    });

    // ── ops-incident-engine ────────────────────────────────────────────
    // Consumes incident signals from the same ops Postgres the receiver owns
    // (the receiver runs the migrations). Direct mode unless an SQS queue URL
    // is supplied; pager defaults to noop.
    const incidentEngineLogGroup = new logs.LogGroup(
      this,
      "OpsIncidentEngineLogs",
      {
        logGroupName: `/axira/ops/${env}/ops-incident-engine`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      },
    );
    const incidentEngineTaskRole = new iam.Role(
      this,
      "OpsIncidentEngineTaskRole",
      {
        roleName: `axira-ops-${env}-incident-engine-task`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        description: "Task role for axira-ops/incident-engine Fargate tasks",
      },
    );
    incidentEngineTaskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadOpsSecrets",
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:axira-ops/${env}/*`,
        ],
      }),
    );
    incidentEngineLogGroup.grantWrite(incidentEngineTaskRole);

    // ── Incident-engine signal queue + DLQ + SNS subscription ──────────
    // The engine's SQS signal source consumes ops-events off the fanout to
    // open/resolve incidents. WITHOUT this queue + subscription the engine
    // boots into DirectSignalSource (consumes nothing) and the Incidents view
    // is always empty. Same shape as the slack/runbook queues above. The SNS
    // filter restricts to the kinds the alert pack actually has rules for
    // (firing kinds + service.recovered for auto-clear), so the engine isn't
    // flooded by service.snapshot/errors.rollup and won't open structural-
    // fallback incidents on them. Parameterized by ${env}, so prod gets its
    // own axira-ops-incident-queue-prod + subscription automatically on deploy.
    const incidentEngineDeadLetterQueue = new sqs.Queue(
      this,
      "IncidentEngineDLQ",
      {
        queueName: `axira-ops-incident-dlq-${env}`,
        retentionPeriod: Duration.days(14),
      },
    );
    const incidentEngineQueue = new sqs.Queue(this, "IncidentEngineQueue", {
      queueName: `axira-ops-incident-queue-${env}`,
      visibilityTimeout: Duration.seconds(30),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: incidentEngineDeadLetterQueue,
        maxReceiveCount: 5,
      },
    });
    this.fanoutTopic.addSubscription(
      new snsSubscriptions.SqsSubscription(incidentEngineQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          kind: sns.SubscriptionFilter.stringFilter({
            allowlist: [
              "infra.snapshot",
              "error_group.new",
              "error_group.spike",
              "service.unhealthy",
              "service.recovered",
              "circuit_breaker.opened",
              "deployment.rolled_back",
            ],
          }),
        },
      }),
    );
    incidentEngineQueue.grantConsumeMessages(incidentEngineTaskRole);

    new CfnOutput(this, "IncidentEngineQueueUrl", {
      value: incidentEngineQueue.queueUrl,
      description:
        "Incident engine SQS queue URL - passed to the engine as INCIDENT_ENGINE_QUEUE_URL",
      exportName: `${exportPrefix}IncidentEngineQueueUrl`,
    });

    const incidentEngineTaskDef = new ecs.FargateTaskDefinition(
      this,
      "OpsIncidentEngineTaskDef",
      {
        cpu: isProd ? 512 : 256,
        memoryLimitMiB: isProd ? 1024 : 512,
        family: `axira-ops-${env}-incident-engine`,
        taskRole: incidentEngineTaskRole,
      },
    );
    incidentEngineTaskDef.addContainer("app", {
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(
          this,
          "OpsIncidentEngineRepo",
          `axira-ops/incident-engine-${env}`,
        ),
        imageTag,
      ),
      environment: {
        NODE_ENV: env,
        AWS_REGION: this.region,
        PAGER_PROVIDER: "noop",
        ALERT_PACK_DB_ENABLED: "true",
        // Wires the engine's SQS signal source to the fanout queue created
        // above (else it falls back to DirectSignalSource and consumes nothing).
        INCIDENT_ENGINE_QUEUE_URL: incidentEngineQueue.queueUrl,
        LOG_LEVEL: "info",
        ...dbConnEnv,
      },
      secrets: { ...dbPasswordSecret },
      command: withAssembledDbUrl(
        "node apps/ops-incident-engine/dist/index.js",
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "incident-engine",
        logGroup: incidentEngineLogGroup,
      }),
    });

    const incidentEngineService = new ecs.FargateService(
      this,
      "OpsIncidentEngineService",
      {
        cluster: this.cluster,
        taskDefinition: incidentEngineTaskDef,
        desiredCount: svc(1),
        securityGroups: [workerSecurityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        circuitBreaker: { rollback: true },
        minHealthyPercent: 0,
        maxHealthyPercent: 100,
      },
    );
    this.receiverDatabase.connections.allowDefaultPortFrom(
      incidentEngineService,
    );

    // ── Outputs ────────────────────────────────────────────────────────
    new CfnOutput(this, "OpsReceiverEndpoint", {
      value: this.receiverEndpoint,
      description: "Public HTTPS endpoint for the ops-plane-receiver",
      exportName: `${exportPrefix}ReceiverEndpoint`,
    });

    new CfnOutput(this, "OpsFanoutTopicArn", {
      value: this.fanoutTopic.topicArn,
      description:
        "SNS topic for receiver fanout to Slack adapter + future S3 archive consumer",
      exportName: `${exportPrefix}FanoutTopicArn`,
    });

    new CfnOutput(this, "OpsServiceTokenSecretArn", {
      value: this.serviceTokenSecret.secretArn,
      description: "Admin service-token Secrets Manager ARN",
      exportName: `${exportPrefix}ServiceTokenSecretArn`,
    });

    new CfnOutput(this, "OpsArchiveBucketName", {
      value: this.archiveBucket.bucketName,
      description:
        "S3 bucket for ops-event archive (consumer ships in a future session)",
      exportName: `${exportPrefix}ArchiveBucketName`,
    });
  }
}
