import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as redshiftserverless from "aws-cdk-lib/aws-redshiftserverless";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

/**
 * Narrow config interface for the dev Redshift workgroup.
 *
 * Intentionally not coupled to the main EnvironmentConfig (staging/production
 * topology) — the DW dev workgroup is a standalone concern provisioned from a
 * separate bin entry (bin/axira-dw.ts).
 */
export interface RedshiftStackConfig {
  /** Logical env label, e.g. "dev". Used in resource names. */
  envName: string;
  /** AWS account id. */
  account: string;
  /** AWS region, e.g. "us-east-1". */
  region: string;
  /** Base RPU capacity for the Serverless workgroup. Minimum 8. */
  baseRpuCapacity: number;
  /** Default database name created inside the namespace. */
  databaseName: string;
  /** CIDR ranges allowed inbound on port 5439. */
  allowedIngressCidrs: string[];
  /** S3 bucket name pattern the COPY-role can read from. Wildcards allowed. */
  s3ArchiveBucketPattern: string;
  /**
   * Schedule for the COPY orchestrator Lambda. Default: every 5 minutes.
   * Pass `undefined` to skip provisioning the orchestrator entirely (e.g.,
   * during the migration window when the sidecar still runs synchronous COPY).
   */
  copyOrchestratorSchedule?: events.Schedule;
  /**
   * How many recent hours of S3 partitions the orchestrator scans each tick.
   * Default 2 (current hour + 1 prior) — enough to absorb scheduler jitter +
   * late-arriving files without listing the entire archive.
   */
  copyOrchestratorLookbackHours?: number;
}

/**
 * Provisions a Redshift Serverless namespace + workgroup with a public endpoint
 * restricted by security-group ingress, an admin secret in Secrets Manager,
 * and an IAM role the cluster assumes for COPY-from-S3.
 *
 * Designed for the Genesis DW dev/local workflow — devs connect from their
 * laptops via psql/redshift-connector once their IP is in `allowedIngressCidrs`.
 */
export class RedshiftStack extends cdk.Stack {
  public readonly workgroupName: string;
  public readonly namespaceName: string;
  public readonly endpointAddress: string;
  public readonly adminSecret: secretsmanager.Secret;
  public readonly copyRole: iam.Role;
  public readonly archiveBucket: s3.Bucket;
  /**
   * Lambda function that owns the scheduled COPY-from-S3 → Redshift loading
   * in the S3-first architecture. Undefined when `copyOrchestratorSchedule`
   * is unset on the stack config.
   */
  public readonly copyOrchestrator?: lambda.Function;

  constructor(
    scope: Construct,
    id: string,
    config: RedshiftStackConfig,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    if (config.baseRpuCapacity < 8) {
      throw new Error("Redshift Serverless minimum base capacity is 8 RPU");
    }
    if (config.allowedIngressCidrs.length === 0) {
      throw new Error(
        "allowedIngressCidrs must include at least one CIDR (your laptop's public IP/32). " +
          "Open 0.0.0.0/0 is explicitly rejected — set DEV_ALLOWED_IPS to your IP.",
      );
    }
    for (const cidr of config.allowedIngressCidrs) {
      if (cidr === "0.0.0.0/0") {
        throw new Error(
          "0.0.0.0/0 is not permitted for the dev Redshift endpoint. " +
            "Use a specific IP/32 (find yours via `curl https://api.ipify.org`).",
        );
      }
    }

    // -----------------------------------------------------------------------
    // 0. S3 archive bucket — sidecar batches events here; Redshift COPYs from it.
    // -----------------------------------------------------------------------
    this.archiveBucket = new s3.Bucket(this, "ArchiveBucket", {
      bucketName: `axira-dwh-archive-${config.envName}-${config.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          // Dev: keep batched events 30 days then delete. Adjust per env.
          // Prod will keep 7 years per regulatory requirement (separate stack).
          id: "dev-retention",
          enabled: true,
          expiration: cdk.Duration.days(30),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // -----------------------------------------------------------------------
    // 1. Admin credentials → Secrets Manager
    // -----------------------------------------------------------------------
    this.adminSecret = new secretsmanager.Secret(this, "AdminCredentials", {
      secretName: `axira/${config.envName}/redshift/admin`,
      description: `Axira Redshift Serverless admin credentials (${config.envName})`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "awsuser" }),
        generateStringKey: "password",
        // Redshift password constraints: 8-64 chars, upper+lower+digit, no \ / @ " '
        excludePunctuation: false,
        excludeCharacters: "\\/@\"'",
        passwordLength: 32,
        requireEachIncludedType: true,
      },
    });

    // -----------------------------------------------------------------------
    // 2. IAM role for COPY-from-S3 (Redshift assumes this role when running
    //    `COPY axira.event_log FROM 's3://...' IAM_ROLE 'arn:...'`)
    // -----------------------------------------------------------------------
    this.copyRole = new iam.Role(this, "CopyRole", {
      roleName: `axira-${config.envName}-redshift-copy`,
      description:
        "Role Redshift Serverless assumes to read from S3 archive bucket",
      assumedBy: new iam.ServicePrincipal("redshift.amazonaws.com"),
      inlinePolicies: {
        S3ArchiveRead: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "ListArchiveBucket",
              actions: ["s3:GetBucketLocation", "s3:ListBucket"],
              resources: [this.archiveBucket.bucketArn],
            }),
            new iam.PolicyStatement({
              sid: "ReadArchiveObjects",
              actions: ["s3:GetObject"],
              resources: [`${this.archiveBucket.bucketArn}/*`],
            }),
          ],
        }),
      },
    });

    // -----------------------------------------------------------------------
    // 3. Networking — use the account's default VPC for public-endpoint dev.
    //    Redshift Serverless needs subnets in 3 distinct AZs.
    // -----------------------------------------------------------------------
    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const sg = new ec2.SecurityGroup(this, "RedshiftSecurityGroup", {
      vpc,
      securityGroupName: `axira-${config.envName}-redshift`,
      description: "Redshift Serverless: allow 5439 from configured CIDRs only",
      allowAllOutbound: true,
    });
    for (const cidr of config.allowedIngressCidrs) {
      sg.addIngressRule(
        ec2.Peer.ipv4(cidr),
        ec2.Port.tcp(5439),
        `Redshift access from ${cidr}`,
      );
    }

    // Redshift Serverless requires ≥3 subnets across ≥3 AZs. Default VPC has
    // one subnet per AZ in every region (us-east-1 has 6). We pass all public
    // subnets and let Redshift pick 3+. The check is deferred to deploy time —
    // CFN gives a clear error if subnet count is insufficient, and synth-time
    // lookups can return a 2-AZ placeholder before context is cached.
    const publicSubnets = vpc.publicSubnets;

    // -----------------------------------------------------------------------
    // 4. Namespace — the logical container for databases, users, schemas
    // -----------------------------------------------------------------------
    const namespace = new redshiftserverless.CfnNamespace(this, "Namespace", {
      namespaceName: `axira-${config.envName}-dw`,
      adminUsername: "awsuser",
      // CFN dynamic reference — actual password resolved at deploy time, never
      // appears in the synthesized template.
      adminUserPassword: this.adminSecret
        .secretValueFromJson("password")
        .unsafeUnwrap(),
      dbName: config.databaseName,
      iamRoles: [this.copyRole.roleArn],
      defaultIamRoleArn: this.copyRole.roleArn,
      logExports: ["userlog", "connectionlog", "useractivitylog"],
    });
    this.namespaceName = namespace.namespaceName!;

    // -----------------------------------------------------------------------
    // 5. Workgroup — the compute layer (auto-scales between baseRpu and 512)
    // -----------------------------------------------------------------------
    const workgroup = new redshiftserverless.CfnWorkgroup(this, "Workgroup", {
      workgroupName: `axira-${config.envName}-dw`,
      namespaceName: this.namespaceName,
      baseCapacity: config.baseRpuCapacity,
      publiclyAccessible: true,
      subnetIds: publicSubnets.map((s) => s.subnetId),
      securityGroupIds: [sg.securityGroupId],
      enhancedVpcRouting: false,
      configParameters: [
        // Force SSL — connections must use TLS
        { parameterKey: "require_ssl", parameterValue: "true" },
        // Cap query execution at 5 min — prevents runaway dev queries from
        // racking up RPU-hours. (Session-level `statement_timeout` is set
        // separately if needed.)
        { parameterKey: "max_query_execution_time", parameterValue: "300" },
        // Enable per-user activity log for debugging
        {
          parameterKey: "enable_user_activity_logging",
          parameterValue: "true",
        },
      ],
    });
    workgroup.addDependency(namespace);
    this.workgroupName = workgroup.workgroupName!;
    this.endpointAddress = workgroup.attrWorkgroupEndpointAddress;

    // -----------------------------------------------------------------------
    // 6. Connection details → CloudFormation outputs
    //    (Surface for `cdk deploy` output + AWS console "Outputs" tab)
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, "Endpoint", {
      value: workgroup.attrWorkgroupEndpointAddress,
      description: "Redshift Serverless endpoint host",
      exportName: `axira-${config.envName}-redshift-endpoint`,
    });
    new cdk.CfnOutput(this, "Port", {
      value: "5439",
      description: "Redshift port",
    });
    new cdk.CfnOutput(this, "DatabaseName", {
      value: config.databaseName,
      description: "Default database",
    });
    new cdk.CfnOutput(this, "AdminSecretArn", {
      value: this.adminSecret.secretArn,
      description:
        "Admin credentials secret. Fetch password: aws secretsmanager get-secret-value --secret-id <arn>",
    });
    new cdk.CfnOutput(this, "CopyRoleArn", {
      value: this.copyRole.roleArn,
      description:
        "IAM role for COPY-from-S3 (use in COPY command IAM_ROLE clause)",
      exportName: `axira-${config.envName}-redshift-copy-role`,
    });
    new cdk.CfnOutput(this, "ArchiveBucketName", {
      value: this.archiveBucket.bucketName,
      description: "S3 bucket where the sidecar writes batched events for COPY",
      exportName: `axira-${config.envName}-dwh-archive-bucket`,
    });
    new cdk.CfnOutput(this, "ArchiveBucketArn", {
      value: this.archiveBucket.bucketArn,
      description:
        "ARN of the archive bucket (use in IAM policies for sidecar write)",
    });
    new cdk.CfnOutput(this, "ConnectCommand", {
      value: `PGPASSWORD="$(aws secretsmanager get-secret-value --secret-id ${this.adminSecret.secretArn} --query SecretString --output text | jq -r .password)" psql -h ${workgroup.attrWorkgroupEndpointAddress} -p 5439 -U awsuser -d ${config.databaseName}`,
      description:
        "Copy-paste psql command (requires aws CLI + jq + psql installed)",
    });

    // -----------------------------------------------------------------------
    // 7. Scheduled COPY orchestrator (S3-first architecture, §4.5)
    //    Fires every 5 min, lists new S3 files since last manifest entry,
    //    runs COPY FROM S3, records progress in axira.dw_copy_log.
    //    Skipped if `copyOrchestratorSchedule` is unset (allows partial deploys
    //    during the synchronous-COPY → S3-first migration window).
    // -----------------------------------------------------------------------
    if (config.copyOrchestratorSchedule !== undefined) {
      const orchestratorRole = new iam.Role(this, "CopyOrchestratorRole", {
        roleName: `axira-${config.envName}-dw-copy-orchestrator`,
        description:
          "Execution role for the scheduled COPY orchestrator Lambda " +
          "(reads S3 listings, executes Redshift Data API statements, " +
          "emits CloudWatch metrics).",
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSLambdaBasicExecutionRole",
          ),
        ],
      });

      // S3 access — list event_type partitions, write COPY manifests, and
      // write per-fact-table JSONPaths files. JSONPaths live under
      // _meta/fact-jsonpaths/ and are regenerated each tick from the
      // dispatch map in fact_dispatch.py.
      this.archiveBucket.grantRead(orchestratorRole);
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "WriteCopyManifestsAndJsonpaths",
          actions: ["s3:PutObject"],
          resources: [
            `${this.archiveBucket.bucketArn}/_manifests/*`,
            `${this.archiveBucket.bucketArn}/_meta/*`,
            // After a successful COPY, the orchestrator moves loaded files
            // from `event_type=…/…` to `_archive/event_type=…/…` so the
            // next tick's LIST only sees unprocessed files. Hive partitioning
            // is preserved under `_archive/`. See _archive_loaded_files()
            // in infra/lambda/copy-orchestrator/handler.py.
            `${this.archiveBucket.bucketArn}/_archive/*`,
          ],
        }),
      );

      // The archive move is a CopyObject + DeleteObject pair (S3 has no
      // atomic rename). DeleteObject is scoped to the live prefix only —
      // the orchestrator should never delete files already in `_archive/`
      // or the operational `_manifests/` / `_meta/` prefixes.
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "DeleteLoadedFilesFromLivePrefix",
          actions: ["s3:DeleteObject"],
          resources: [`${this.archiveBucket.bucketArn}/event_type=*`],
        }),
      );

      // Redshift Data API — split into two statements because of AWS's IAM model:
      //   - ExecuteStatement targets a workgroup → scope to workgroup ARN
      //   - DescribeStatement / GetStatementResult / CancelStatement operate on
      //     a statement ID (not a targetable ARN) → must be Resource: "*".
      //     Documented at
      //     https://docs.aws.amazon.com/redshift/latest/mgmt/redshift-iam-access-control-identity-based.html#redshift-policy-resources.resource-permissions
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "RedshiftDataExecute",
          actions: [
            "redshift-data:ExecuteStatement",
            // BatchExecuteStatement is used by the MERGE strategy in
            // handler.py (multi-statement atomic transaction for staging +
            // UPDATE + cleanup). IAM treats it as a separate action.
            "redshift-data:BatchExecuteStatement",
          ],
          resources: [
            `arn:aws:redshift-serverless:${config.region}:${config.account}:workgroup/*`,
          ],
        }),
      );
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "RedshiftDataStatementOps",
          actions: [
            "redshift-data:DescribeStatement",
            "redshift-data:GetStatementResult",
            "redshift-data:CancelStatement",
          ],
          resources: ["*"],
        }),
      );

      // Redshift Serverless requires this when using IAM-based auth via Data API
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "RedshiftServerlessGetCredentials",
          actions: ["redshift-serverless:GetCredentials"],
          resources: [
            `arn:aws:redshift-serverless:${config.region}:${config.account}:workgroup/*`,
          ],
        }),
      );

      // CloudWatch metrics — best-effort, scoped to our namespace
      orchestratorRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "PublishOrchestratorMetrics",
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
          conditions: {
            StringEquals: {
              "cloudwatch:namespace": "AxiraDW/CopyOrchestrator",
            },
          },
        }),
      );

      // The Lambda needs to be able to PASS the Redshift COPY role when it
      // issues `COPY ... IAM_ROLE '<copy-role-arn>' ...`. That's handled by
      // the role being in the namespace's iamRoles list (set above); no
      // explicit iam:PassRole is required for Redshift to assume it.

      // Read the admin secret so the Lambda can authenticate as `awsuser` for
      // Data API calls. Without this, Redshift auths as the Lambda's
      // auto-mapped IAM-role DB user (e.g. "IAMR:axira-dev-dw-copy-orchestrator")
      // which has no GRANTs on the axira schema. Using the admin secret keeps
      // the orchestrator's DB-level permissions aligned with the sidecar's.
      this.adminSecret.grantRead(orchestratorRole);

      const lambdaFunction = new lambda.Function(this, "CopyOrchestrator", {
        functionName: `axira-${config.envName}-dw-copy-orchestrator`,
        description:
          "Scheduled COPY orchestrator — reads S3 archive, loads into Redshift, " +
          "tracks progress in axira.dw_copy_log.",
        runtime: lambda.Runtime.PYTHON_3_12,
        handler: "handler.handler",
        // ESM-safe equivalent of `path.join(__dirname, ...)`. The package is
        // "type": "module", so __dirname isn't defined; use import.meta.dirname
        // (Node 20.11+).
        code: lambda.Code.fromAsset(
          path.join(import.meta.dirname, "..", "lambda", "copy-orchestrator"),
        ),
        timeout: cdk.Duration.minutes(5),
        memorySize: 256,
        // NOTE: we considered `reservedConcurrentExecutions: 1` to make the
        // orchestrator a strict singleton (concurrent ticks race on file
        // listings — both see the same live-prefix files, both COPY them,
        // and the loser hits NoSuchKey on archive move; INSERT-only event
        // types would also get duplicate rows). But this dev account's
        // Lambda concurrency quota is at the minimum floor (10), so
        // reserving even 1 fails with "decreases UnreservedConcurrent below
        // 10". Request a quota increase before adding this. Until then,
        // mitigation = "don't manually invoke during a scheduled tick's
        // ~15s window"; the 5-min EventBridge cadence has 4m45s headroom.
        role: orchestratorRole,
        logRetention: logs.RetentionDays.ONE_MONTH,
        environment: {
          DW_REDSHIFT_WORKGROUP: this.workgroupName,
          DW_REDSHIFT_DB: config.databaseName,
          DW_REDSHIFT_SCHEMA: "axira",
          DW_REDSHIFT_SECRET_ARN: this.adminSecret.secretArn,
          DW_S3_BUCKET: this.archiveBucket.bucketName,
          DW_S3_JSONPATHS_KEY: "_meta/event-log-jsonpaths.v2.json",
          DW_COPY_ROLE_ARN: this.copyRole.roleArn,
          DW_LOOKBACK_HOURS: String(config.copyOrchestratorLookbackHours ?? 2),
        },
      });

      new events.Rule(this, "CopyOrchestratorSchedule", {
        ruleName: `axira-${config.envName}-dw-copy-schedule`,
        description:
          "Fires the COPY orchestrator on a fixed cadence (see §4.5 arch doc).",
        schedule: config.copyOrchestratorSchedule,
        targets: [new eventsTargets.LambdaFunction(lambdaFunction)],
      });

      (this as { copyOrchestrator?: lambda.Function }).copyOrchestrator =
        lambdaFunction;

      new cdk.CfnOutput(this, "CopyOrchestratorArn", {
        value: lambdaFunction.functionArn,
        description: "Scheduled COPY orchestrator Lambda ARN",
      });
      new cdk.CfnOutput(this, "CopyOrchestratorLogGroup", {
        value: `/aws/lambda/${lambdaFunction.functionName}`,
        description:
          "CloudWatch Logs group — `aws logs tail <name> --follow` to watch ticks live",
      });
    }

    cdk.Tags.of(this).add("axira:component", "dw");
    cdk.Tags.of(this).add("axira:env", config.envName);
    cdk.Tags.of(this).add("axira:cost-center", "dwh");
  }
}
