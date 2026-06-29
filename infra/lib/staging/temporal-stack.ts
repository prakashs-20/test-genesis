// Temporal server on Fargate, registered in Cloud Map at temporal.axira.internal.
//
// Production hardening (replaces the dev temporalio/auto-setup-as-a-service
// pattern):
//   1. Schema + least-privilege DB user are provisioned ONCE by a one-shot
//      Fargate task running the temporalio/admin-tools image (ships
//      temporal-sql-tool + psql). A Lambda-backed custom resource runs that
//      task on deploy and BLOCKS until it exits 0.
//   2. The long-running server runs temporalio/server (server-only), pinned to
//      the same patch version as admin-tools, with desiredCount fixed replicas
//      (NOT autoscaled - a Temporal cluster is a fixed-size ringpop membership).
//   3. The server authenticates as the least-priv `temporal_admin` user
//      (secrets.temporalDbSecret), NOT the Aurora master. Only the one-shot
//      setup task uses the master creds (it needs CREATE DATABASE / CREATE USER).
//   4. After the server is up, a second one-shot task registers the `axira`
//      namespace (auto-setup used to do this; server-only does not).

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_kms as kms,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
  aws_servicediscovery as servicediscovery,
  custom_resources as cr,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";
import type { DatabaseStack } from "./database-stack.js";
import type { SecretsStack } from "./secrets-stack.js";

// Pin a concrete matching patch version for BOTH images. The bare `1.25` tag is
// a moving minor pointer; pinning the patch keeps the schema the setup task
// applies in lockstep with the server binary that reads it. 1.25.2 is the
// latest 1.25.x. The admin-tools tag bundles its tctl/cli versions in the tag.
const TEMPORAL_SERVER_IMAGE = "temporalio/server:1.25.2";
const TEMPORAL_ADMIN_TOOLS_IMAGE =
  "temporalio/admin-tools:1.25.2-tctl-1.18.1-cli-1.1.2";

const TEMPORAL_DB = "temporal";
const TEMPORAL_VISIBILITY_DB = "temporal_visibility";
const TEMPORAL_NAMESPACE = "axira";
// The embedded postgres schema dirs shipped inside the admin-tools image. Used
// by temporal-sql-tool update-schema --schema-dir (the postgres embedded
// --schema-name is not exposed for update-schema in 1.25, only for setup).
const PG_SCHEMA_BASE = "/etc/temporal/schema/postgresql/v12";

export class TemporalStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly grpcEndpoint: string;
  // The fixed server replica count (prod 3 / staging 1). Exposed so the
  // monitoring stack can alarm on RunningTaskCount < desiredCount. The server
  // is NOT autoscaled - a Temporal cluster is a fixed-size ringpop membership.
  public readonly desiredCount: number;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    shared: SharedProps,
    cluster: ecs.ICluster,
    database: DatabaseStack,
    secrets: SecretsStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.desiredCount = envCfg.temporal.desiredCount;

    // Import the CMK + both DB secrets via complete-ARN so grants only mutate
    // identity policies in THIS stack (never the upstream secret/key resource
    // policy), keeping the dependency direction Temporal -> Secrets and
    // avoiding the cyclic stack reference that a live cross-stack grant causes.
    //   - appDbSecret (master, axira_admin): used ONLY by the one-shot setup
    //     task: it needs CREATE DATABASE / CREATE USER / GRANT.
    //   - temporalDbSecret (least-priv, temporal_admin): the runtime identity
    //     the long-running server authenticates with. The setup task sets this
    //     user's password from the same secret, so server + setup agree.
    const importedAppKey = kms.Key.fromKeyArn(
      this,
      "ImportedAppKey",
      secrets.appKey.keyArn,
    );
    const importedMasterSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedMasterSecret",
      secrets.appDbSecret.secretArn,
    );
    const importedTemporalSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedTemporalSecret",
      secrets.temporalDbSecret.secretArn,
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/axira/${envCfg.name}/temporal`,
      retention: this.logRetentionFromDays(envCfg.retention.logRetentionDays),
      encryptionKey: importedAppKey,
      // Only prod envs (genesis-prod, axira-los) retain the log group. Staging
      // envs destroy on stack delete so rollbacks don't orphan a uniquely-named
      // group and block the next deploy. Pre-rollback logs are still available
      // via `aws logs tail` during the failed deploy itself.
      removalPolicy: isProdEnv(envCfg.name)
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });

    const auroraHost = database.auroraCluster.clusterEndpoint.hostname;

    // ─── One-shot schema + least-priv user setup task ───────────────────────
    const setupTaskDef = this.buildSetupTaskDef(
      envCfg,
      auroraHost,
      importedMasterSecret,
      importedTemporalSecret,
      secrets,
      logGroup,
    );

    // ─── Custom resource that runs the setup task once and waits for exit 0 ──
    const setupResource = this.buildTaskRunnerCustomResource(
      "SchemaSetup",
      cluster,
      setupTaskDef,
      shared,
      envCfg,
      // Re-run the setup task whenever the image or DB target changes so a
      // version bump re-applies update-schema. Stable otherwise (idempotent
      // create-database / setup-schema tolerate "already exists").
      {
        image: TEMPORAL_ADMIN_TOOLS_IMAGE,
        host: auroraHost,
      },
    );

    // ─── Long-running server (server-only image, least-priv creds) ──────────
    const serverTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: envCfg.temporal.cpu,
      memoryLimitMiB: envCfg.temporal.memoryMiB,
    });

    // Execution role: pull the temporal-user secret + decrypt with the CMK.
    // Granting on the imported ISecret only adds to the role policy in THIS
    // stack (the auto-grant via ecs.Secret.fromSecretsManager is unreliable on
    // complete-ARN imports, hence the explicit grant).
    const serverExecutionRole = serverTaskDef.obtainExecutionRole();
    importedTemporalSecret.grantRead(serverExecutionRole);
    serverExecutionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    serverTaskDef.addContainer("temporal", {
      image: ecs.ContainerImage.fromRegistry(TEMPORAL_SERVER_IMAGE),
      essential: true,
      portMappings: [
        { containerPort: 7233, name: "grpc" },
        { containerPort: 7234, name: "membership" },
        { containerPort: 8233, name: "http" },
      ],
      environment: {
        DB: "postgres12",
        DB_PORT: "5432",
        POSTGRES_SEEDS: auroraHost,
        DBNAME: TEMPORAL_DB,
        VISIBILITY_DBNAME: TEMPORAL_VISIBILITY_DB,
        TEMPORAL_NAMESPACE,
        // TLS for the SERVER runtime persistence pool. The server image's
        // config_template.yaml gates the postgres datastore TLS on
        // SQL_TLS_ENABLED (NOT POSTGRES_TLS_ENABLED, which only drives the
        // sql-tool's --tls flag in the auto-setup wrapper, which the
        // server-only image does not run). Aurora's parameter group sets
        // rds.force_ssl=1 on genesis-prod, so the runtime connection MUST be
        // TLS or postgres rejects with "no pg_hba.conf entry ... no
        // encryption". Host verification is disabled because the aws-managed
        // RDS cert's SAN matches the cluster endpoint and the pgx client checks
        // the host string literally.
        SQL_TLS_ENABLED: "true",
        SQL_HOST_VERIFICATION: "false",
        // Belt-and-suspenders for any code path that still reads the
        // POSTGRES_* names.
        POSTGRES_TLS_ENABLED: "true",
        POSTGRES_TLS_DISABLE_HOST_VERIFICATION: "true",
      },
      secrets: {
        // Runtime identity: the least-priv temporal_admin user, NOT the master.
        POSTGRES_USER: ecs.Secret.fromSecretsManager(
          importedTemporalSecret,
          "username",
        ),
        POSTGRES_PWD: ecs.Secret.fromSecretsManager(
          importedTemporalSecret,
          "password",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "temporal", logGroup }),
      // No container healthCheck: a tctl/grpc probe can exit non-zero while the
      // ring is still forming and trip the circuit breaker prematurely. ECS
      // task health (running == healthy) is sufficient: the workflow-engine
      // clients connect with gRPC retries and ride out transient
      // unreachability themselves.
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: serverTaskDef,
      desiredCount: this.desiredCount,
      assignPublicIp: false,
      securityGroups: [shared.serviceSg!],
      cloudMapOptions: {
        cloudMapNamespace: shared.serviceDiscoveryNamespace!,
        name: "temporal",
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    // The server must not start until the schema + least-priv user exist.
    this.service.node.addDependency(setupResource);

    // Service → Aurora ingress is already opened on dbSg in NetworkStack
    // (`dbSg.addIngressRule(serviceSg, 5432)`), so both the setup task and the
    // server (all on serviceSg) can reach Aurora. Re-adding it here via
    // `auroraCluster.connections.allowDefaultPortFrom(serviceSg)` would mutate
    // the remote SG and create a cyclic stack dependency (network <-> database).

    // ─── One-shot namespace registration (after the server is reachable) ────
    // The server-only image does NOT register the default namespace (auto-setup
    // did). Run `temporal operator namespace create` against the Cloud Map
    // endpoint with a short retry loop so it tolerates the server still forming
    // its ring, and tolerate "already exists" so re-deploys are idempotent.
    const namespaceTaskDef = this.buildNamespaceTaskDef(envCfg, logGroup);
    const namespaceResource = this.buildTaskRunnerCustomResource(
      "NamespaceSetup",
      cluster,
      namespaceTaskDef,
      shared,
      envCfg,
      { image: TEMPORAL_ADMIN_TOOLS_IMAGE, namespace: TEMPORAL_NAMESPACE },
    );
    namespaceResource.node.addDependency(this.service);

    this.grpcEndpoint = "temporal.axira.internal:7233";
    new CfnOutput(this, "TemporalGrpcEndpoint", { value: this.grpcEndpoint });
  }

  // One-shot task: create both temporal databases, apply + update schema, and
  // create the least-priv runtime user. Runs as the Aurora MASTER (CREATE
  // DATABASE / CREATE USER / GRANT need it). All steps are idempotent so a
  // re-deploy is safe.
  private buildSetupTaskDef(
    envCfg: EnvConfig,
    auroraHost: string,
    importedMasterSecret: secretsmanager.ISecret,
    importedTemporalSecret: secretsmanager.ISecret,
    secrets: SecretsStack,
    logGroup: logs.ILogGroup,
  ): ecs.FargateTaskDefinition {
    const taskDef = new ecs.FargateTaskDefinition(this, "SetupTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const executionRole = taskDef.obtainExecutionRole();
    importedMasterSecret.grantRead(executionRole);
    importedTemporalSecret.grantRead(executionRole);
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    taskDef.addContainer("setup", {
      image: ecs.ContainerImage.fromRegistry(TEMPORAL_ADMIN_TOOLS_IMAGE),
      essential: true,
      // The admin-tools image ENTRYPOINT is ["tini","--","sleep","infinity"] (a
      // keep-alive for interactive `docker exec` use). Left in place it swallows
      // `command` and the container sleeps forever (no script, no logs). Override
      // the entrypoint so the setup script actually runs.
      entryPoint: ["bash", "-c"],
      command: [this.buildSetupScript(auroraHost)],
      environment: {
        SQL_PLUGIN: "postgres12",
        SQL_HOST: auroraHost,
        SQL_PORT: "5432",
        // sql-tool TLS to Aurora (matches the server's runtime TLS).
        SQL_TLS: "true",
        SQL_TLS_DISABLE_HOST_VERIFICATION: "true",
        TEMPORAL_DB,
        TEMPORAL_VISIBILITY_DB,
        PG_SCHEMA_BASE,
      },
      secrets: {
        // Master creds drive create-database / schema / CREATE USER.
        SQL_USER: ecs.Secret.fromSecretsManager(
          importedMasterSecret,
          "username",
        ),
        SQL_PASSWORD: ecs.Secret.fromSecretsManager(
          importedMasterSecret,
          "password",
        ),
        // The password to assign the least-priv temporal_admin user; the
        // server reads the SAME secret for its runtime password.
        TEMPORAL_DB_USER: ecs.Secret.fromSecretsManager(
          importedTemporalSecret,
          "username",
        ),
        TEMPORAL_DB_PASSWORD: ecs.Secret.fromSecretsManager(
          importedTemporalSecret,
          "password",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "temporal-setup",
        logGroup,
      }),
    });

    return taskDef;
  }

  // The setup shell script. Order matters: databases first, then schema as the
  // master (so tables are created), then the least-priv user with explicit
  // GRANTs on the already-created objects plus DEFAULT PRIVILEGES for any future
  // objects. set -euo pipefail so any failed step fails the task (and thus the
  // custom resource / deploy).
  private buildSetupScript(auroraHost: string): string {
    const sslConn = `host=${auroraHost} port=5432 sslmode=require`;
    // psql connection string for the master, against the default `axira` db
    // (CREATE USER / GRANT are cluster/db-scoped operations run from any db).
    const masterPsqlBase = `PGPASSWORD="$SQL_PASSWORD" psql "${sslConn} dbname=axira user=$SQL_USER" -v ON_ERROR_STOP=1`;
    const grantDbPsql = (db: string): string =>
      `PGPASSWORD="$SQL_PASSWORD" psql "${sslConn} dbname=${db} user=$SQL_USER" -v ON_ERROR_STOP=1`;

    // temporal-sql-tool reads SQL_HOST/SQL_PORT/SQL_USER/SQL_PASSWORD/SQL_PLUGIN
    // /SQL_TLS from the env; --db scopes the per-database commands.
    const sqlTool = (db: string): string => `temporal-sql-tool --db ${db}`;

    return [
      "set -euo pipefail",
      'echo "[temporal-setup] creating databases (idempotent)"',
      // create-database creates the target db; temporal-sql-tool connects to the
      // postgres system db internally to issue CREATE DATABASE. `--db` is the
      // target (and --db/--database are the SAME flag, so don't pass both).
      // Tolerate "already exists".
      `${sqlTool(TEMPORAL_DB)} create-database || echo "[temporal-setup] ${TEMPORAL_DB} db exists"`,
      `${sqlTool(TEMPORAL_VISIBILITY_DB)} create-database || echo "[temporal-setup] ${TEMPORAL_VISIBILITY_DB} db exists"`,

      'echo "[temporal-setup] applying main schema"',
      // setup-schema -v 0.0 establishes the versioning tables; update-schema
      // walks the versioned dir to latest. Both are idempotent.
      `${sqlTool(TEMPORAL_DB)} setup-schema -v 0.0`,
      `${sqlTool(TEMPORAL_DB)} update-schema --schema-dir ${PG_SCHEMA_BASE}/temporal/versioned`,

      'echo "[temporal-setup] applying visibility schema"',
      `${sqlTool(TEMPORAL_VISIBILITY_DB)} setup-schema -v 0.0`,
      `${sqlTool(TEMPORAL_VISIBILITY_DB)} update-schema --schema-dir ${PG_SCHEMA_BASE}/visibility/versioned`,

      'echo "[temporal-setup] creating least-priv runtime user (idempotent)"',
      // CREATE ROLE if absent, then (re)set the password to match the secret so
      // a rotated secret re-syncs on the next deploy. Postgres has no CREATE
      // USER IF NOT EXISTS, hence the DO block.
      `${masterPsqlBase} -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$TEMPORAL_DB_USER') THEN CREATE ROLE \\"$TEMPORAL_DB_USER\\" LOGIN PASSWORD '$TEMPORAL_DB_PASSWORD'; END IF; END \\$\\$;"`,
      `${masterPsqlBase} -c "ALTER ROLE \\"$TEMPORAL_DB_USER\\" WITH LOGIN PASSWORD '$TEMPORAL_DB_PASSWORD';"`,

      'echo "[temporal-setup] granting least-priv user on temporal databases"',
      // Per-database grants. CONNECT on the db, USAGE+CREATE on the public
      // schema (Temporal opens transactions that touch sequences), and full
      // DML/DDL on existing + future tables/sequences in public. The schema was
      // created by the master, so the runtime user needs explicit object grants.
      ...[TEMPORAL_DB, TEMPORAL_VISIBILITY_DB].flatMap((db) => [
        `${grantDbPsql(db)} -c "GRANT CONNECT ON DATABASE \\"${db}\\" TO \\"$TEMPORAL_DB_USER\\";"`,
        `${grantDbPsql(db)} -c "GRANT USAGE, CREATE ON SCHEMA public TO \\"$TEMPORAL_DB_USER\\";"`,
        `${grantDbPsql(db)} -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO \\"$TEMPORAL_DB_USER\\";"`,
        `${grantDbPsql(db)} -c "GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO \\"$TEMPORAL_DB_USER\\";"`,
        `${grantDbPsql(db)} -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO \\"$TEMPORAL_DB_USER\\";"`,
        `${grantDbPsql(db)} -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO \\"$TEMPORAL_DB_USER\\";"`,
      ]),

      'echo "[temporal-setup] done"',
    ].join("\n");
  }

  // One-shot task that registers the default namespace against the live server.
  private buildNamespaceTaskDef(
    envCfg: EnvConfig,
    logGroup: logs.ILogGroup,
  ): ecs.FargateTaskDefinition {
    const taskDef = new ecs.FargateTaskDefinition(this, "NamespaceTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    // Retention: prod keeps 30d of completed-workflow visibility; staging 3d.
    const retentionDays = isProdEnv(envCfg.name) ? "30d" : "3d";

    taskDef.addContainer("namespace", {
      image: ecs.ContainerImage.fromRegistry(TEMPORAL_ADMIN_TOOLS_IMAGE),
      essential: true,
      // Same admin-tools keep-alive entrypoint override as the setup task, so the
      // namespace-registration command runs instead of being swallowed by sleep.
      entryPoint: ["bash", "-c"],
      command: [
        [
          "set -uo pipefail",
          'addr="temporal.axira.internal:7233"',
          // Retry until the frontend answers (ring may still be forming).
          "for i in $(seq 1 30); do",
          "  if temporal operator namespace describe --namespace " +
            `${TEMPORAL_NAMESPACE} --address "$addr" >/dev/null 2>&1; then`,
          `    echo "[temporal-namespace] ${TEMPORAL_NAMESPACE} already exists"; exit 0;`,
          "  fi",
          "  if temporal operator namespace create --namespace " +
            `${TEMPORAL_NAMESPACE} --retention ${retentionDays} --address "$addr"; then`,
          `    echo "[temporal-namespace] created ${TEMPORAL_NAMESPACE}"; exit 0;`,
          "  fi",
          '  echo "[temporal-namespace] server not ready yet, retry $i"; sleep 10;',
          "done",
          'echo "[temporal-namespace] gave up waiting for the server"; exit 1',
        ].join("\n"),
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "temporal-namespace",
        logGroup,
      }),
    });

    return taskDef;
  }

  // A Lambda-backed custom resource that runs a one-shot Fargate task and BLOCKS
  // until it stops, failing the deploy if the task exits non-zero. AwsCustomResource
  // with ecs:RunTask alone is fire-and-forget (returns before the task finishes),
  // so a Lambda that runTask + polls describeTasks is required to gate the server
  // on a COMPLETED setup. Mirrors the cr.Provider pattern used in
  // observability-stack for the OpenSearch index setup.
  private buildTaskRunnerCustomResource(
    idPrefix: string,
    cluster: ecs.ICluster,
    taskDef: ecs.FargateTaskDefinition,
    shared: SharedProps,
    envCfg: EnvConfig,
    triggerProps: Record<string, string>,
  ): cdk.CustomResource {
    const runnerLambda = new lambda.Function(this, `${idPrefix}Runner`, {
      functionName: `axira-${envCfg.name}-temporal-${idPrefix.toLowerCase()}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      // Up to ~14 min: the task pulls the admin-tools image (cold) then runs
      // schema migrations / namespace-create retries.
      timeout: Duration.minutes(14),
      memorySize: 256,
      // No reservedConcurrentExecutions: reserving even 1 would drop the
      // account's unreserved pool below AWS's hard minimum of 10. The two
      // runners fire at different lifecycle points, not concurrently.
      code: lambda.Code.fromInline(TASK_RUNNER_LAMBDA_SOURCE),
    });

    const subnetIds = shared.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    runnerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDef.taskDefinitionArn],
        conditions: {
          ArnEquals: { "ecs:cluster": cluster.clusterArn },
        },
      }),
    );
    runnerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        // DescribeTasks does not support resource-level scoping by task-def;
        // scope by cluster instead.
        resources: ["*"],
        conditions: {
          ArnEquals: { "ecs:cluster": cluster.clusterArn },
        },
      }),
    );
    // RunTask must pass the task + execution roles to ECS.
    runnerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          taskDef.taskRole.roleArn,
          taskDef.obtainExecutionRole().roleArn,
        ],
      }),
    );

    const provider = new cr.Provider(this, `${idPrefix}Provider`, {
      onEventHandler: runnerLambda,
    });

    return new cdk.CustomResource(this, `${idPrefix}Resource`, {
      serviceToken: provider.serviceToken,
      properties: {
        cluster: cluster.clusterArn,
        taskDefinition: taskDef.taskDefinitionArn,
        subnetIds: subnetIds.join(","),
        securityGroupId: shared.serviceSg!.securityGroupId,
        // Changing any trigger value forces the custom resource to re-run the
        // task on the next deploy (e.g. an image version bump).
        ...triggerProps,
      },
    });
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

// Inline Lambda (Node 22, AWS SDK v3 is on the runtime) that runs a one-shot
// Fargate task and polls until it stops, throwing on a non-zero exit so the
// deploy fails loudly. On Delete it is a no-op (the task is transient; nothing
// to tear down). Idempotent across CFN retries: each invocation runs a fresh
// task; the underlying SQL / namespace operations are themselves idempotent.
const TASK_RUNNER_LAMBDA_SOURCE = `
const { ECSClient, RunTaskCommand, DescribeTasksCommand } = require("@aws-sdk/client-ecs");

const ecs = new ECSClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  const physicalResourceId =
    event.PhysicalResourceId || \`temporal-task-\${event.LogicalResourceId}\`;

  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId };
  }

  const props = event.ResourceProperties || {};
  const subnets = String(props.subnetIds || "").split(",").filter(Boolean);

  const run = await ecs.send(
    new RunTaskCommand({
      cluster: props.cluster,
      taskDefinition: props.taskDefinition,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets,
          securityGroups: [props.securityGroupId],
          assignPublicIp: "DISABLED",
        },
      },
    })
  );

  const failures = run.failures || [];
  if (failures.length > 0) {
    throw new Error("RunTask failed: " + JSON.stringify(failures));
  }
  const taskArn = run.tasks && run.tasks[0] && run.tasks[0].taskArn;
  if (!taskArn) {
    throw new Error("RunTask returned no task ARN");
  }

  // Poll until STOPPED (Lambda timeout is the outer bound).
  let task;
  for (;;) {
    await sleep(10000);
    const desc = await ecs.send(
      new DescribeTasksCommand({ cluster: props.cluster, tasks: [taskArn] })
    );
    task = desc.tasks && desc.tasks[0];
    if (task && task.lastStatus === "STOPPED") break;
  }

  const containers = task.containers || [];
  const bad = containers.find(
    (c) => c.exitCode === undefined || c.exitCode === null || c.exitCode !== 0
  );
  if (bad) {
    throw new Error(
      "Temporal setup task container '" +
        (bad.name || "?") +
        "' exited " +
        String(bad.exitCode) +
        " (" +
        (task.stoppedReason || bad.reason || "no reason") +
        ")"
    );
  }

  return { PhysicalResourceId: physicalResourceId };
};
`;
