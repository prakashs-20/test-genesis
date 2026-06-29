// Self-hosted OpenFGA server on Fargate, registered in Cloud Map at
// openfga.axira.internal:8080.
//
// The platform's runtime authorization is coupled to OpenFGA: the gateway's
// permissions plugin issues a per-request `check()` on every write route, and
// the V2 tuple-sync engine writes role/capability grants. There is NO managed
// OpenFGA — we run `openfga/openfga` ourselves with a persistent Postgres
// datastore so the store id is STABLE across redeploys.
//
// Production hardening (mirrors temporal-stack.ts):
//   1. A dedicated `openfga` database + least-priv `openfga_admin` role are
//      provisioned ONCE by a one-shot psql Fargate task (postgres image) run by
//      a Lambda-backed custom resource that BLOCKS until exit 0. It runs as the
//      Aurora MASTER (CREATE DATABASE / CREATE ROLE / GRANT need it).
//   2. A second one-shot task runs `openfga migrate` (the openfga image) to
//      create/upgrade the OpenFGA schema in the `openfga` DB, as the least-priv
//      role. It depends on the DB-setup task.
//   3. The long-running server runs `openfga run` with the postgres datastore,
//      authenticating as the least-priv `openfga_admin` role (NOT the master),
//      with preshared-key API auth so the API is not open in-VPC. It autoscales
//      on CPU (OpenFGA is stateless → scales horizontally; Postgres is the
//      shared bottleneck, sized on the `openfga` DB on the shared Aurora).
//   4. After the server is reachable, a Lambda-backed bootstrap custom resource
//      find-or-creates the store `axira-<env>` (STABLE id — Postgres-backed),
//      writes the legacy V1 model (the gateway check path) + the canonical V2
//      model (the sync engine), and MERGES the real storeId/v1ModelId/
//      v2ModelId/apiUrl/apiToken into the `axira/<env>/openfga` provider secret.
//      This stack OWNS that secret end-to-end: the deploy pipeline's
//      seed_secrets job deliberately does NOT write `openfga` (it would clobber
//      these real values with a placeholder). A per-deploy `deployNonce`
//      property on the bootstrap CustomResource (supplied via `-c deployNonce=`
//      on the cdk_finalize deploy) makes this re-merge run on EVERY deploy, so a
//      clobbered/empty secret self-heals on a plain re-trigger. The merge is
//      idempotent (find-or-reuse store, additive model/tuple writes, key-
//      preserving secret merge), so re-runs never duplicate or wipe anything.

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

// Pin a concrete patch version (NOT `latest`). v1.18.0 is the latest stable as
// of this deploy. The same tag drives `openfga migrate` and `openfga run` so the
// schema the migrate task applies stays in lockstep with the server binary.
const OPENFGA_IMAGE = "openfga/openfga:v1.18.0";
// psql for the one-shot DB + role setup (the openfga image is distroless — no
// psql/bash). Pinned to the Aurora major version's client.
const POSTGRES_CLIENT_IMAGE = "postgres:16-alpine";

const OPENFGA_DB = "openfga";
const OPENFGA_DB_ROLE = "openfga_admin";
const OPENFGA_HTTP_PORT = 8080;
const OPENFGA_GRPC_PORT = 8081;
const OPENFGA_CLOUDMAP_NAME = "openfga";
export const OPENFGA_INTERNAL_HTTP = `${OPENFGA_CLOUDMAP_NAME}.axira.internal:${OPENFGA_HTTP_PORT}`;

export class OpenFgaStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  /** http://openfga.axira.internal:8080 — the in-VPC API endpoint. */
  public readonly apiUrl: string;
  /** A dedicated SG for the OpenFGA server; the shared service SG may reach it. */
  public readonly openfgaSg: ec2.SecurityGroup;

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

    this.apiUrl = `http://${OPENFGA_INTERNAL_HTTP}`;
    const auroraHost = database.auroraCluster.clusterEndpoint.hostname;

    // ─── Imports (complete-ARN so grants only mutate THIS stack's role
    // policies, keeping the dependency direction OpenFGA -> {Secrets, Database}
    // and avoiding cyclic stack references). ──────────────────────────────────
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
    const importedOpenfgaProviderSecret =
      secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "ImportedOpenfgaProviderSecret",
        secrets.providerSecrets["openfga"]!.secretArn,
      );

    // ─── Dedicated least-priv DB role credentials for the runtime + migrate.
    // The server + migrate authenticate as this role (NOT the Aurora master);
    // the master is used ONLY by the one-shot DB-setup task (CREATE DATABASE /
    // CREATE ROLE). Owned by THIS stack so there is no Secrets->OpenFGA edge. ──
    const dbRoleSecret = new secretsmanager.Secret(this, "DbRoleSecret", {
      secretName: `axira/${envCfg.name}/postgres-openfga`,
      description:
        "OpenFGA least-priv Postgres role (dedicated openfga DB on the shared Aurora cluster)",
      encryptionKey: importedAppKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: OPENFGA_DB_ROLE }),
        generateStringKey: "password",
        // OpenFGA's datastore URI is a libpq URL — punctuation in the password
        // would need percent-encoding. Excluding it keeps the URI assembly
        // trivial and avoids a class of connection bugs.
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    // ─── Preshared API key. CDK-generated + STABLE (rotating it forces a server
    // redeploy + a secret re-merge, both handled by the bootstrap). Injected
    // into the server (OPENFGA_AUTHN_PRESHARED_KEYS) and published into the
    // provider secret's `apiToken` so the gateway sends it as a Bearer token. ──
    const apiKeySecret = new secretsmanager.Secret(this, "ApiKeySecret", {
      secretName: `axira/${envCfg.name}/openfga-preshared-key`,
      description:
        "OpenFGA preshared API key (server OPENFGA_AUTHN_PRESHARED_KEYS = gateway Bearer token)",
      encryptionKey: importedAppKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "key",
        excludePunctuation: true,
        passwordLength: 48,
      },
    });

    const logGroup = new logs.LogGroup(this, "Logs", {
      logGroupName: `/axira/${envCfg.name}/openfga`,
      retention: this.logRetentionFromDays(envCfg.retention.logRetentionDays),
      encryptionKey: importedAppKey,
      removalPolicy: isProdEnv(envCfg.name)
        ? RemovalPolicy.RETAIN
        : RemovalPolicy.DESTROY,
    });

    // ─── Dedicated SG (the shared service SG may reach openfga:8080/8081). ─────
    this.openfgaSg = new ec2.SecurityGroup(this, "OpenFgaSg", {
      vpc: shared.vpc,
      securityGroupName: `axira-${envCfg.name}-openfga-sg`,
      description: "Self-hosted OpenFGA server",
      allowAllOutbound: true,
    });
    this.openfgaSg.addIngressRule(
      shared.serviceSg!,
      ec2.Port.tcp(OPENFGA_HTTP_PORT),
      "Services to OpenFGA HTTP API",
    );
    this.openfgaSg.addIngressRule(
      shared.serviceSg!,
      ec2.Port.tcp(OPENFGA_GRPC_PORT),
      "Services to OpenFGA gRPC API",
    );
    // The DB-setup + migrate one-shots and the bootstrap Lambda all run on the
    // shared serviceSg (dbSg already allows serviceSg:5432; serviceSg -> openfga:8080
    // is opened above so the bootstrap can reach the server). BUT the long-running
    // SERVER runs on openfgaSg, so it ALSO needs to reach Aurora — and dbSg only
    // allows serviceSg. dbSg lives in NetworkStack, so open it with an explicit
    // ingress RESOURCE in THIS stack (reference dbSg by id) to avoid a
    // network<->openfga dependency cycle that dbSg.addIngressRule(openfgaSg) creates.
    new ec2.CfnSecurityGroupIngress(this, "OpenFgaServerToAurora", {
      groupId: shared.dbSg!.securityGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      sourceSecurityGroupId: this.openfgaSg.securityGroupId,
      description: "OpenFGA server to Aurora",
    });

    // ─── One-shot 1: create the openfga DB + least-priv role (psql, master). ──
    const dbSetupTaskDef = this.buildDbSetupTaskDef(
      envCfg,
      auroraHost,
      importedMasterSecret,
      dbRoleSecret,
      secrets,
      logGroup,
    );
    const dbSetupResource = this.buildTaskRunnerCustomResource(
      "DbSetup",
      cluster,
      dbSetupTaskDef,
      shared,
      envCfg,
      shared.serviceSg!,
      { image: POSTGRES_CLIENT_IMAGE, host: auroraHost, db: OPENFGA_DB },
    );

    // ─── One-shot 2: `openfga migrate` (creates/upgrades the OpenFGA schema). ─
    const migrateTaskDef = this.buildMigrateTaskDef(
      envCfg,
      auroraHost,
      dbRoleSecret,
      secrets,
      logGroup,
    );
    const migrateResource = this.buildTaskRunnerCustomResource(
      "Migrate",
      cluster,
      migrateTaskDef,
      shared,
      envCfg,
      shared.serviceSg!,
      // Re-run on an image bump so a new openfga version re-applies migrations.
      { image: OPENFGA_IMAGE, host: auroraHost },
    );
    migrateResource.node.addDependency(dbSetupResource);

    // ─── Long-running server (`openfga run`, least-priv creds, preshared auth). ─
    const serverTaskDef = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: envCfg.openfga.cpu,
      memoryLimitMiB: envCfg.openfga.memoryMiB,
    });

    const serverExecutionRole = serverTaskDef.obtainExecutionRole();
    dbRoleSecret.grantRead(serverExecutionRole);
    apiKeySecret.grantRead(serverExecutionRole);
    serverExecutionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    serverTaskDef.addContainer("openfga", {
      image: ecs.ContainerImage.fromRegistry(OPENFGA_IMAGE),
      essential: true,
      command: ["run"],
      portMappings: [
        { containerPort: OPENFGA_HTTP_PORT, name: "http" },
        { containerPort: OPENFGA_GRPC_PORT, name: "grpc" },
      ],
      environment: {
        OPENFGA_DATASTORE_ENGINE: "postgres",
        // Per-replica connection pool. Kept below OpenFGA's default of 30 so
        // maxTasks × this stays well under Aurora's max_connections.
        OPENFGA_DATASTORE_MAX_OPEN_CONNS: String(envCfg.openfga.maxOpenConns),
        OPENFGA_DATASTORE_MAX_IDLE_CONNS: String(envCfg.openfga.maxIdleConns),
        // Preshared-key auth so the in-VPC API is not open. The gateway sends
        // the same key as `Authorization: Bearer <key>`.
        OPENFGA_AUTHN_METHOD: "preshared",
        // Playground exposes an unauthenticated UI — keep it OFF everywhere
        // (its default is already false; set explicitly for intent).
        OPENFGA_PLAYGROUND_ENABLED: "false",
        // Prometheus metrics on :2112 for the monitoring stack to scrape later.
        OPENFGA_METRICS_ENABLED: "true",
        OPENFGA_LOG_LEVEL: "info",
        OPENFGA_LOG_FORMAT: "json",
      },
      secrets: {
        // The datastore URI carries the password, and the distroless openfga
        // image has no shell to string-build it at start. So the DB-setup task
        // assembles the full libpq URL (sslmode=require) and stamps it onto
        // dbRoleSecret.datastoreUri; we inject that single value here. The
        // server depends (transitively) on the DB-setup task, so the key exists
        // by the time the server starts.
        OPENFGA_DATASTORE_URI: ecs.Secret.fromSecretsManager(
          dbRoleSecret,
          "datastoreUri",
        ),
        OPENFGA_AUTHN_PRESHARED_KEYS: ecs.Secret.fromSecretsManager(
          apiKeySecret,
          "key",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "openfga", logGroup }),
      // No container healthCheck. The image is distroless (no shell/wget/curl),
      // and OpenFGA's `/healthz` (→ {"status":"SERVING"}) gates on datastore
      // connectivity, which can flap during the post-migrate cold start and
      // trip the deployment circuit breaker prematurely. Mirror temporal: rely
      // on ECS task health (running == healthy); the gateway's FGA client
      // retries, and the bootstrap custom resource has its own retry loop. The
      // image ships grpc_health_probe if a probe is wanted later.
    });

    this.service = new ecs.FargateService(this, "Service", {
      cluster,
      taskDefinition: serverTaskDef,
      serviceName: `axira-${envCfg.name}-openfga`,
      desiredCount: envCfg.openfga.minTasks,
      assignPublicIp: false,
      securityGroups: [this.openfgaSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      cloudMapOptions: {
        cloudMapNamespace: shared.serviceDiscoveryNamespace!,
        name: OPENFGA_CLOUDMAP_NAME,
        dnsRecordType: servicediscovery.DnsRecordType.A,
      },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: !isProdEnv(envCfg.name),
      minHealthyPercent: isProdEnv(envCfg.name) ? 100 : 50,
      maxHealthyPercent: 200,
    });

    // The server must not start until the schema (and least-priv role) exist.
    this.service.node.addDependency(migrateResource);

    // ─── CPU-target autoscaling (OpenFGA is stateless → horizontal). ──────────
    if (envCfg.openfga.maxTasks > envCfg.openfga.minTasks) {
      const scaling = this.service.autoScaleTaskCount({
        minCapacity: envCfg.openfga.minTasks,
        maxCapacity: envCfg.openfga.maxTasks,
      });
      scaling.scaleOnCpuUtilization("CpuScaling", {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.seconds(120),
        scaleOutCooldown: Duration.seconds(60),
      });
    }

    // ─── Bootstrap: find-or-create store + write models + merge into the
    // provider secret. Runs after the server is reachable. ───────────────────
    //
    // Per-deploy nonce so the BootstrapResource's onUpdate fires on EVERY real
    // deploy: the pipeline passes `-c deployNonce=<run id>` on the cdk_finalize
    // `cdk deploy`, so the CustomResource property changes each deploy and CDK
    // re-runs the (idempotent) bootstrap — re-merging the real storeId/modelId/
    // apiUrl/apiToken into the openfga secret. This is what lets a clobbered
    // env (e.g. the openfga secret left empty by a prior seed bug) self-heal on
    // a plain re-trigger. Absent the flag (local `cdk synth`/`cdk diff`), it
    // falls back to a FIXED string so synth stays deterministic (no Date.now()).
    const deployNonce =
      (this.node.tryGetContext("deployNonce") as string | undefined) ??
      "static";
    const bootstrapResource = this.buildBootstrapCustomResource(
      envCfg,
      shared,
      apiKeySecret,
      importedOpenfgaProviderSecret,
      deployNonce,
    );
    bootstrapResource.node.addDependency(this.service);

    new CfnOutput(this, "OpenFgaApiUrl", { value: this.apiUrl });
    new CfnOutput(this, "OpenFgaServiceName", {
      value: this.service.serviceName,
    });
  }

  // One-shot: create the openfga DB + least-priv role + grants, and stamp the
  // full datastore URI (libpq URL, sslmode=require) into dbRoleSecret so the
  // server can inject it as a single OPENFGA_DATASTORE_URI value. Runs as the
  // Aurora MASTER. All steps idempotent.
  private buildDbSetupTaskDef(
    envCfg: EnvConfig,
    auroraHost: string,
    importedMasterSecret: secretsmanager.ISecret,
    dbRoleSecret: secretsmanager.Secret,
    secrets: SecretsStack,
    logGroup: logs.ILogGroup,
  ): ecs.FargateTaskDefinition {
    const taskDef = new ecs.FargateTaskDefinition(this, "DbSetupTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const executionRole = taskDef.obtainExecutionRole();
    importedMasterSecret.grantRead(executionRole);
    dbRoleSecret.grantRead(executionRole);
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    // The task role (not the execution role) GETs the current secret then PUTs the
    // assembled URI back onto dbRoleSecret (the aws-cli reads, jq-merges, writes).
    dbRoleSecret.grantRead(taskDef.taskRole);
    dbRoleSecret.grantWrite(taskDef.taskRole);
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    taskDef.addContainer("db-setup", {
      image: ecs.ContainerImage.fromRegistry(POSTGRES_CLIENT_IMAGE),
      essential: true,
      command: [
        "sh",
        "-c",
        this.buildDbSetupScript(auroraHost, dbRoleSecret.secretArn),
      ],
      environment: {
        OPENFGA_DB,
        OPENFGA_DB_ROLE,
        AURORA_HOST: auroraHost,
        AWS_REGION: this.region,
        DB_ROLE_SECRET_ARN: dbRoleSecret.secretArn,
      },
      secrets: {
        PGUSER_MASTER: ecs.Secret.fromSecretsManager(
          importedMasterSecret,
          "username",
        ),
        PGPASSWORD_MASTER: ecs.Secret.fromSecretsManager(
          importedMasterSecret,
          "password",
        ),
        OPENFGA_DB_PASSWORD: ecs.Secret.fromSecretsManager(
          dbRoleSecret,
          "password",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "openfga-db-setup",
        logGroup,
      }),
    });

    return taskDef;
  }

  // The DB-setup shell script. postgres:16-alpine has apk, so we install the
  // postgres client + aws-cli, create the role + database + grants as the
  // master, then assemble the libpq datastore URL and merge it onto
  // dbRoleSecret.datastoreUri (so the distroless server image can inject it as
  // a single OPENFGA_DATASTORE_URI value). All steps idempotent.
  private buildDbSetupScript(
    auroraHost: string,
    dbRoleSecretArn: string,
  ): string {
    const conn = `host=${auroraHost} port=5432 sslmode=require dbname=axira user=$PGUSER_MASTER`;
    const psql = `PGPASSWORD="$PGPASSWORD_MASTER" psql "${conn}" -v ON_ERROR_STOP=1`;
    // Assembled libpq URL the server injects as OPENFGA_DATASTORE_URI. Password
    // is punctuation-free (excludePunctuation), so no percent-encoding needed.
    const datastoreUri = `postgres://${OPENFGA_DB_ROLE}:$OPENFGA_DB_PASSWORD@${auroraHost}:5432/${OPENFGA_DB}?sslmode=require`;
    return [
      "set -eu",
      'echo "[openfga-db-setup] installing psql + aws-cli + jq"',
      // postgresql16-client gives psql; aws-cli + jq for the URI write-back.
      "apk add --no-cache postgresql16-client aws-cli jq >/dev/null 2>&1 || apk add --no-cache postgresql-client aws-cli jq",
      'echo "[openfga-db-setup] creating role (idempotent)"',
      // CREATE ROLE if absent, then (re)set the password to match the secret.
      `${psql} -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OPENFGA_DB_ROLE}') THEN CREATE ROLE ${OPENFGA_DB_ROLE} LOGIN PASSWORD '$OPENFGA_DB_PASSWORD'; END IF; END \\$\\$;"`,
      `${psql} -c "ALTER ROLE ${OPENFGA_DB_ROLE} WITH LOGIN PASSWORD '$OPENFGA_DB_PASSWORD';"`,
      // The RDS master is NOT a superuser, so to CREATE DATABASE ... OWNER <role>
      // it must first be a member of that role (else Postgres rejects with
      // "must be able to SET ROLE"). Grant openfga_admin to the master (idempotent).
      `${psql} -c "GRANT ${OPENFGA_DB_ROLE} TO CURRENT_USER;"`,
      'echo "[openfga-db-setup] creating database (idempotent)"',
      // CREATE DATABASE cannot run in a DO block / transaction; gate on a
      // catalog check via psql -tc, create only when absent, owned by the role.
      `if [ "$(${psql} -tAc "SELECT 1 FROM pg_database WHERE datname='${OPENFGA_DB}'")" != "1" ]; then ${psql} -c "CREATE DATABASE ${OPENFGA_DB} OWNER ${OPENFGA_DB_ROLE};"; else echo "[openfga-db-setup] ${OPENFGA_DB} db exists"; fi`,
      'echo "[openfga-db-setup] granting role on the openfga db"',
      // Connect to the openfga db to grant schema privileges. OpenFGA's migrate
      // creates its own tables, so USAGE+CREATE on public is what it needs.
      `PGPASSWORD="$PGPASSWORD_MASTER" psql "host=${auroraHost} port=5432 sslmode=require dbname=${OPENFGA_DB} user=$PGUSER_MASTER" -v ON_ERROR_STOP=1 -c "GRANT ALL ON SCHEMA public TO ${OPENFGA_DB_ROLE};"`,
      `${psql} -c "GRANT CONNECT ON DATABASE ${OPENFGA_DB} TO ${OPENFGA_DB_ROLE};"`,
      'echo "[openfga-db-setup] writing datastore URI into the role secret"',
      // Merge the assembled URI into dbRoleSecret so the server injects one
      // value. jq does a clean JSON merge (no fragile sed on a URL). Idempotent:
      // re-runs just overwrite .datastoreUri with the same value.
      `DS_URI="${datastoreUri}"`,
      `CUR=$(aws secretsmanager get-secret-value --region ${this.region} --secret-id "${dbRoleSecretArn}" --query SecretString --output text)`,
      `NEW=$(printf '%s' "$CUR" | jq -c --arg uri "$DS_URI" '. + {datastoreUri: $uri}')`,
      `aws secretsmanager put-secret-value --region ${this.region} --secret-id "${dbRoleSecretArn}" --secret-string "$NEW" >/dev/null`,
      'echo "[openfga-db-setup] datastoreUri written"',
      'echo "[openfga-db-setup] done"',
    ].join("\n");
  }

  // One-shot: `openfga migrate` against the openfga DB as the least-priv role.
  private buildMigrateTaskDef(
    envCfg: EnvConfig,
    auroraHost: string,
    dbRoleSecret: secretsmanager.Secret,
    secrets: SecretsStack,
    logGroup: logs.ILogGroup,
  ): ecs.FargateTaskDefinition {
    const taskDef = new ecs.FargateTaskDefinition(this, "MigrateTaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
    });

    const executionRole = taskDef.obtainExecutionRole();
    dbRoleSecret.grantRead(executionRole);
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [secrets.appKey.keyArn],
      }),
    );

    taskDef.addContainer("migrate", {
      image: ecs.ContainerImage.fromRegistry(OPENFGA_IMAGE),
      essential: true,
      // `openfga migrate` reads OPENFGA_DATASTORE_ENGINE + OPENFGA_DATASTORE_URI
      // from the env (the same uniform flag↔env mapping as `run`). The DB-setup
      // task stamped the full URI into dbRoleSecret.datastoreUri.
      command: ["migrate"],
      environment: {
        OPENFGA_DATASTORE_ENGINE: "postgres",
      },
      secrets: {
        OPENFGA_DATASTORE_URI: ecs.Secret.fromSecretsManager(
          dbRoleSecret,
          "datastoreUri",
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "openfga-migrate",
        logGroup,
      }),
    });

    return taskDef;
  }

  // Lambda-backed custom resource that find-or-creates the store, writes the V1
  // + V2 models, and merges the result into the `openfga` provider secret.
  private buildBootstrapCustomResource(
    envCfg: EnvConfig,
    shared: SharedProps,
    apiKeySecret: secretsmanager.Secret,
    importedProviderSecret: secretsmanager.ISecret,
    deployNonce: string,
  ): cdk.CustomResource {
    const fn = new lambda.Function(this, "BootstrapFn", {
      functionName: `axira-${envCfg.name}-openfga-bootstrap`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      // 10 min is ample headroom: the batched seed (BATCH=50, ~17 writes for
      // ~800 valid tuples) completes in seconds; the budget only matters if the
      // server is still cold-starting and the retry loop is polling.
      timeout: Duration.minutes(10),
      // 512MB (up from 256) gives comfortable margin for the read-diff Set of
      // all existing tuples + the batch payloads. Observed Max Memory Used was
      // ~117MB, so this is generous.
      memorySize: 512,
      // Runs in-VPC on the shared service SG so it can reach
      // openfga.axira.internal (serviceSg -> openfgaSg:8080 is opened above).
      vpc: shared.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [shared.serviceSg!],
      code: lambda.Code.fromInline(BOOTSTRAP_LAMBDA_SOURCE),
      environment: {
        OPENFGA_API_URL: this.apiUrl,
        STORE_NAME: `axira-${envCfg.name}`,
      },
    });

    apiKeySecret.grantRead(fn);
    importedProviderSecret.grantRead(fn);
    importedProviderSecret.grantWrite(fn);
    // The provider secret + api key are encrypted with the app CMK.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:CallerAccount": this.account },
        },
      }),
    );

    const provider = new cr.Provider(this, "BootstrapProvider", {
      onEventHandler: fn,
    });

    return new cdk.CustomResource(this, "BootstrapResource", {
      serviceToken: provider.serviceToken,
      properties: {
        apiKeySecretArn: apiKeySecret.secretArn,
        providerSecretArn: importedProviderSecret.secretArn,
        apiUrl: this.apiUrl,
        storeName: `axira-${envCfg.name}`,
        // Bump to force a re-run (e.g. model change OR tuple-seed change). The
        // model JSON + tuple set are embedded in the Lambda, so an edit +
        // redeploy re-bootstraps.
        // v1+v2-2: permission type now defines role_<name> for every canonical
        // role (kebab) so the gateway permissionResolver's listObjects stops
        // 404-ing on role_workspace-admin et al.
        // v1+v2-3: bootstrap now SEEDS the V1 baseline grant tuples (the
        // product×action can_* + permission role_* wildcard grants, mirroring
        // apps/gateway/scripts/bootstrap-openfga.ts writeTuples) after the
        // model write. Previously the store had the right relations but ZERO
        // grant tuples, so every requirePermission() check 403'd. Now every
        // deploy self-seeds them idempotently — no manual seeding.
        // v1+v2-4: drop the group-(3) "full permission" tuples
        // (permission:audit:read et al). Their object id carries a colon, which
        // OpenFGA v1.18.0 rejects (validation_error: invalid 'object' field
        // format), failing the whole bootstrap on a 400. They were redundant —
        // the gateway resolver supplies that set via BASELINE_PERMISSIONS — and
        // the dev seeder only ever silently swallowed the same failure. Also
        // made fga() fail-fast on a non-404 4xx (was retrying 30×5s ≈ 150s per
        // bad call, which is what blew the seed run to ~300s).
        modelVersion: "v1+v2-4",
        // Per-deploy nonce (the pipeline passes `-c deployNonce=<run id>` on the
        // cdk_finalize deploy). Changing this property each real deploy forces
        // the CustomResource onUpdate to fire so `cdk deploy --all` RE-RUNS the
        // bootstrap and re-merges the real storeId/modelId/apiUrl/apiToken into
        // the `axira/<env>/openfga` secret. The bootstrap is fully idempotent —
        // findOrCreateStore reuses the existing store id, writeModel/seedTuples
        // are additive + dedup, and the secret merge preserves other keys — so
        // re-running against an existing OpenFGA store reuses it and re-writes
        // the same values, never creating duplicates or wiping the store (Delete
        // is a no-op). Absent the flag (local synth/diff) it is the fixed
        // "static" fallback, keeping synth deterministic.
        deployNonce,
      },
    });
  }

  // A Lambda-backed custom resource that runs a one-shot Fargate task and BLOCKS
  // until it stops, failing the deploy on a non-zero exit. Mirrors the temporal
  // schema-setup runner.
  private buildTaskRunnerCustomResource(
    idPrefix: string,
    cluster: ecs.ICluster,
    taskDef: ecs.FargateTaskDefinition,
    shared: SharedProps,
    envCfg: EnvConfig,
    taskSg: ec2.ISecurityGroup,
    triggerProps: Record<string, string>,
  ): cdk.CustomResource {
    const runnerLambda = new lambda.Function(this, `${idPrefix}Runner`, {
      functionName: `axira-${envCfg.name}-openfga-${idPrefix.toLowerCase()}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.minutes(14),
      memorySize: 256,
      code: lambda.Code.fromInline(TASK_RUNNER_LAMBDA_SOURCE),
    });

    const subnetIds = shared.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    runnerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDef.taskDefinitionArn],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
    runnerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:DescribeTasks"],
        resources: ["*"],
        conditions: { ArnEquals: { "ecs:cluster": cluster.clusterArn } },
      }),
    );
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
        securityGroupId: taskSg.securityGroupId,
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

// Inline Lambda that runs a one-shot Fargate task and polls until STOPPED,
// throwing on a non-zero exit so the deploy fails loudly. Delete is a no-op.
const TASK_RUNNER_LAMBDA_SOURCE = `
const { ECSClient, RunTaskCommand, DescribeTasksCommand } = require("@aws-sdk/client-ecs");
const ecs = new ECSClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = async (event) => {
  const physicalResourceId =
    event.PhysicalResourceId || \`openfga-task-\${event.LogicalResourceId}\`;
  if (event.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId };
  }
  const props = event.ResourceProperties || {};
  const subnets = String(props.subnetIds || "").split(",").filter(Boolean);

  const run = await ecs.send(new RunTaskCommand({
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
  }));
  const failures = run.failures || [];
  if (failures.length > 0) throw new Error("RunTask failed: " + JSON.stringify(failures));
  const taskArn = run.tasks && run.tasks[0] && run.tasks[0].taskArn;
  if (!taskArn) throw new Error("RunTask returned no task ARN");

  let task;
  for (;;) {
    await sleep(10000);
    const desc = await ecs.send(new DescribeTasksCommand({ cluster: props.cluster, tasks: [taskArn] }));
    task = desc.tasks && desc.tasks[0];
    if (task && task.lastStatus === "STOPPED") break;
  }
  const containers = task.containers || [];
  const bad = containers.find((c) => c.exitCode === undefined || c.exitCode === null || c.exitCode !== 0);
  if (bad) {
    throw new Error(
      "OpenFGA setup task container '" + (bad.name || "?") + "' exited " +
      String(bad.exitCode) + " (" + (task.stoppedReason || bad.reason || "no reason") + ")"
    );
  }
  return { PhysicalResourceId: physicalResourceId };
};
`;

// Inline Lambda that bootstraps the store + models against the live OpenFGA
// server, then merges the stable ids + endpoint + token into the `openfga`
// provider secret. Idempotent: find-or-create the store by name; models are
// versioned by OpenFGA (each write returns a new id, but find-or-create keeps
// the STORE id stable across redeploys — that is the durable handle).
//
// On Create/Update it does the work; on Delete it is a no-op (deleting the
// store would orphan every tuple — leave it to manual teardown).
const BOOTSTRAP_LAMBDA_SOURCE = `
const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const sm = new SecretsManagerClient({});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Legacy V1 model (the gateway permission CHECK path: product/permission/
// rule_pack/org/record-scoped types). Mirrors apps/gateway/scripts/
// bootstrap-openfga.ts AUTHORIZATION_MODEL. Kept in sync by hand. ──
const ACTIONS = ["read","write","admin","promote","approve","rollback","test","simulate","guidance","operator","platform","codepath","stage","check","submit","draft","list","export","tag","assign","move-stage","watchlist","bulk-tag","bulk-assign","bulk-watchlist","bulk-move-stage"];
const userTypes = [{ type: "user" }, { type: "user", wildcard: {} }];
function rel() { return { this: {} }; }
function meta(types) { return { directly_related_user_types: types }; }
const recordTypes = ["deal","party","document","loan","property"];
// permissionResolver (apps/gateway/src/composition/container.ts) calls
// listObjects(type=permission, relation="role_<jwtRole>") for EVERY role on the
// JWT. The canonical role redesign moved JWTs to kebab role names
// (workspace-admin, loan-officer, …); a model that only defines the old
// {role_admin, role_lo, role_underwriter, role_examiner, role_credit_officer,
// role_borrower} relations makes OpenFGA reject every other role with
// relation_not_found ("relation 'permission#role_workspace-admin' not found"),
// crashing JWT auth's permission pre-resolution and 403-ing every gated route.
// Define a role_<name> relation for EVERY name a JWT can carry: the 14
// tenant-assignable canonical roles + viewer + operator + borrower, the
// deprecated aliases still minted on old tokens, and the original V1 legacy
// relations (kept so nothing that depended on them breaks). Source of truth:
// packages/permissions/specs/canonical-roles.yaml +
// packages/permissions/src/types.ts (PlatformRole). Keep in sync with
// apps/gateway/scripts/bootstrap-openfga.ts AUTHORIZATION_MODEL.
const PERMISSION_ROLE_NAMES = [
  // Canonical tenant-assignable (14) + viewer
  "workspace-admin","security-admin","loan-officer","loan-administrator",
  "underwriter","loan-closer","funding-officer","loan-servicer",
  "portfolio-manager","valuations-specialist","compliance-officer",
  "quality-control-reviewer","data-engineer","special-assets-officer","viewer",
  // Non-tenant-assignable canonical
  "operator","borrower",
  // Deprecated aliases retained so existing JWTs still resolve
  "admin","senior-underwriter","credit-analyst","analyst","editor",
  // Original V1 legacy relations (preserve so prior tuples/checks keep working)
  "lo","examiner","credit_officer",
];
const permissionRelations = {};
const permissionRelationsMeta = {};
for (const name of PERMISSION_ROLE_NAMES) {
  permissionRelations["role_" + name] = rel();
  // borrower stays user-only (Customer Central per-actor tuples, no wildcard);
  // every other relation keeps the V1 user + user:* wildcard shape.
  permissionRelationsMeta["role_" + name] =
    name === "borrower" ? meta([{ type: "user" }]) : meta(userTypes);
}
const V1_MODEL = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user", relations: {}, metadata: {} },
    {
      type: "product",
      relations: Object.fromEntries(ACTIONS.map((a) => ["can_" + a, rel()])),
      metadata: { relations: Object.fromEntries(ACTIONS.map((a) => ["can_" + a, meta(userTypes)])) },
    },
    {
      type: "permission",
      relations: permissionRelations,
      metadata: { relations: permissionRelationsMeta },
    },
    { type: "rule_pack", relations: { owner: rel(), reviewer: rel() }, metadata: { relations: { owner: meta([{ type: "user" }]), reviewer: meta([{ type: "user" }]) } } },
    {
      type: "org",
      relations: { member: rel(), editor: rel() },
      metadata: { relations: { member: meta([{ type: "user" }]), editor: meta([{ type: "user" }]) } },
    },
    ...recordTypes.map((t) => ({
      type: t,
      relations: {
        parent_org: rel(),
        team_member: rel(),
        editor: { union: { child: [{ this: {} }, { computedUserset: { relation: "team_member" } }] } },
        viewer: { union: { child: [{ this: {} }, { computedUserset: { relation: "editor" } }, { tupleToUserset: { tupleset: { relation: "parent_org" }, computedUserset: { relation: "member" } } }] } },
        confidential_viewer: { union: { child: [{ this: {} }, { computedUserset: { relation: "team_member" } }] } },
      },
      metadata: { relations: {
        parent_org: meta([{ type: "org" }]),
        team_member: meta([{ type: "user" }]),
        editor: meta([{ type: "user" }]),
        viewer: meta([{ type: "user" }]),
        confidential_viewer: meta([{ type: "user" }]),
      } },
    })),
  ],
};

// ── Canonical V2 model (the tuple-sync engine: user/tenant/role/capability/
// rule_pack). Mirrors packages/auth/src/openfga-model.ts CANONICAL_AUTH_MODEL_V2. ──
const V2_MODEL = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user", relations: {}, metadata: { relations: {} } },
    { type: "tenant", relations: { member: { this: {} } }, metadata: { relations: { member: { directly_related_user_types: [{ type: "user" }] } } } },
    { type: "role", relations: { assignee: { this: {} } }, metadata: { relations: { assignee: { directly_related_user_types: [{ type: "user" }] } } } },
    {
      type: "capability",
      relations: { holder: { this: {} }, granted: { computedUserset: { object: "", relation: "holder" } } },
      metadata: { relations: { holder: { directly_related_user_types: [{ type: "role", relation: "assignee" }] } } },
    },
    { type: "rule_pack", relations: { owner: { this: {} }, reviewer: { this: {} } }, metadata: { relations: { owner: { directly_related_user_types: [{ type: "user" }] }, reviewer: { directly_related_user_types: [{ type: "user" }] } } } },
  ],
};

async function getSecretJson(arn) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  try { return JSON.parse(r.SecretString || "{}"); } catch { return {}; }
}

async function fga(apiUrl, token, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  let lastErr;
  // Retry: the server may still be forming on the first poll after deploy.
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(apiUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const text = await res.text();
      // A non-404 4xx is a DETERMINISTIC error (bad request, validation,
      // auth) — retrying it just wastes the whole 30×5s budget (that is what
      // pushed the tuple-seed run to ~300s). Fail fast: mark the error so the
      // retry-catch below rethrows it immediately instead of sleeping+looping.
      if (res.status >= 400 && res.status < 500 && res.status !== 404) {
        const fatal = new Error("OpenFGA " + method + " " + path + " -> " + res.status + ": " + text);
        fatal.fatal = true;
        throw fatal;
      }
      // 404 (server still forming) + 5xx are transient — keep retrying.
      lastErr = new Error("OpenFGA " + method + " " + path + " -> " + res.status + ": " + text);
    } catch (e) {
      // Surface deterministic 4xx (and any non-network throw we tagged) at once.
      if (e && e.fatal) throw e;
      lastErr = e;
    }
    await sleep(5000);
  }
  throw lastErr || new Error("OpenFGA request failed after retries: " + path);
}

async function findOrCreateStore(apiUrl, token, storeName) {
  // GET /stores paginates; scan for an exact name match. Reuse the id when
  // present (STABLE across redeploys — this is the durable store handle).
  let continuationToken;
  do {
    const q = continuationToken ? "?continuation_token=" + encodeURIComponent(continuationToken) : "";
    const list = await fga(apiUrl, token, "GET", "/stores" + q);
    for (const s of list.stores || []) {
      if (s.name === storeName) return s.id;
    }
    continuationToken = list.continuation_token || undefined;
  } while (continuationToken);
  const created = await fga(apiUrl, token, "POST", "/stores", { name: storeName });
  return created.id;
}

async function writeModel(apiUrl, token, storeId, model) {
  const r = await fga(apiUrl, token, "POST", "/stores/" + storeId + "/authorization-models", model);
  return r.authorization_model_id;
}

// ── V1 baseline tuple seed. SOURCE OF TRUTH:
// apps/gateway/scripts/bootstrap-openfga.ts -> writeTuples() (the local-dev
// seeder). That script is localhost-only + unauthenticated, so it cannot run
// against the deployed in-VPC token-auth server; we replicate its EXACT tuple
// set here so staging + prod self-seed to the same V1 baseline on every deploy
// with zero manual steps. KEEP IN SYNC with writeTuples() — the generation
// logic below mirrors its writable groups: group (1) product can_* and group
// (2) permission role_* (both colon-free object ids) plus the (4) V3 dev seeds.
// Group (3) — the "full permission" grants (permission:audit:read, …) — is
// DELIBERATELY NOT seeded: its object id carries a colon that OpenFGA rejects,
// it has never existed in any store (the dev seeder swallows the same 400), and
// the gateway resolver supplies that exact set via BASELINE_PERMISSIONS. See
// the note above PRODUCTS. The constants ACTIONS + PERMISSION_ROLE_NAMES are
// reused from the V1_MODEL block above (identical source-of-truth lists);
// PRODUCTS + V3_DEV_SEED_TUPLES are the tuple-only inputs.
//
// Every tuple uses the user:* wildcard (public) so any authenticated user gets
// the V1 baseline grant — same as dev. Replace with per-user tuples when the
// V2 sync engine owns grants. borrower is intentionally excluded from the role
// wildcard (it is user-only; per-actor tuples come from
// scripts/bootstrap-cc-borrower-tuples.ts).
const PRODUCTS = ["fabric","dashboard","sponsors","runtime","lending","inbox","tenant","admin","rules","auth","ops","deals","dev","support","intake","connector"];
// NOTE on the manual-check "full permission" grants (audit:read, presence:write,
// deal-room:*, tenant:admin, …): the dev seeder (apps/gateway/scripts/
// bootstrap-openfga.ts group 3) *attempts* to write these as
// permission:<full-permission> role_<role> user:* tuples, but the object id
// then contains a COLON inside the id segment (e.g. "permission:audit:read"),
// which OpenFGA v1.18.0 rejects: 400 validation_error "invalid 'object' field
// format" (":" / "#" / "@" are structural separators, never valid in an id).
// The dev seeder swallows that error silently (catch {}), so those tuples have
// NEVER actually existed in any store — and they do not need to: the gateway's
// permissionResolver (apps/gateway/src/composition/container.ts ~2288) seeds the
// IDENTICAL set unconditionally into its in-memory BASELINE_PERMISSIONS array,
// independent of any OpenFGA listObjects result. So we deliberately DO NOT emit
// group (3) here — writing them would (a) fail validation and (b) be redundant.
// If these ever need to live in the store, encode the inner ":" to an id-safe
// separator (e.g. "__") on BOTH the write here AND the resolver's slice(11)
// decode, and mirror it in the dev seeder. Until then, keep them out.
// V3 Phase A4 dev-principal record seeds (the always-on trust plane boot seed;
// production record tuples are projected from brain assignment edges).
const V3_DEV_SEED_TUPLES = [
  { user: "user:v3-admin-dev", relation: "team_member", object: "deal:dddddddd-0000-4000-8000-000000000001" },
  { user: "user:v3-admin-dev", relation: "team_member", object: "party:aaaaaaa1-0000-4000-8000-000000000001" },
];

function buildV1Tuples() {
  const tuples = [];
  // Roles = every canonical role EXCEPT borrower (user-only), prefixed role_.
  const ROLES = PERMISSION_ROLE_NAMES.filter((n) => n !== "borrower").map((n) => "role_" + n);
  // (1) product:<namespace> can_<action> user:* -- the requirePermission()
  //     check() path (permissionToObject -> product:<ns>, can_<action>).
  for (const product of PRODUCTS) {
    for (const action of ACTIONS) {
      tuples.push({ user: "user:*", relation: "can_" + action, object: "product:" + product });
    }
  }
  // (2) permission:<namespace> role_<role> user:* -- so listObjects from
  //     resolvePermissions does not return empty arrays. Object id has no
  //     action segment (no colons): just the product namespace.
  for (const product of PRODUCTS) {
    for (const role of ROLES) {
      tuples.push({ user: "user:*", relation: role, object: "permission:" + product });
    }
  }
  // (3) The "full permission" manual-check grants are intentionally NOT seeded
  //     as tuples — their object id would carry a colon ("permission:audit:read")
  //     which OpenFGA rejects, and the resolver's BASELINE_PERMISSIONS already
  //     supplies that exact set in-memory. See the long note above PRODUCTS.
  // (4) V3 dev-principal record seeds.
  for (const t of V3_DEV_SEED_TUPLES) tuples.push(t);
  return tuples;
}

// Read EVERY existing tuple in the store (paginated /read with no filter) into
// a Set keyed user|relation|object, so we write only the missing ones. This is
// the primary idempotency guard: OpenFGA's /write rejects the WHOLE batch if a
// single tuple already exists, so re-deploys must not resubmit existing tuples.
async function readExistingTupleKeys(apiUrl, token, storeId) {
  const keys = new Set();
  let continuationToken;
  do {
    const body = { page_size: 100 };
    if (continuationToken) body.continuation_token = continuationToken;
    // /read with an empty tuple_key returns all tuples in the store, paginated.
    const r = await fga(apiUrl, token, "POST", "/stores/" + storeId + "/read", body);
    for (const t of r.tuples || []) {
      const k = t.key || {};
      keys.add((k.user || "") + "|" + (k.relation || "") + "|" + (k.object || ""));
    }
    continuationToken = r.continuation_token || undefined;
  } while (continuationToken);
  return keys;
}

// Returns true when an OpenFGA /write error is the benign "tuple already
// exists" / duplicate case (so re-deploys are safe even if the read-diff
// missed something, e.g. a tuple written concurrently). The server reports
// duplicates as 400 write_failed_due_to_invalid_input with a message that
// mentions the tuple already existing / being a duplicate.
function isDuplicateWriteError(err) {
  const m = String((err && err.message) || err || "").toLowerCase();
  // OpenFGA reports an already-present tuple via a few code/message shapes; all
  // of these are benign on a re-deploy (idempotent seed). Names per
  // @openfga/sdk ErrorCode: write_failed_due_to_invalid_input, already_exists,
  // cannot_allow_duplicate_tuples_in_one_request, duplicate_contextual_tuple.
  return (
    m.includes("already exists") ||
    m.includes("already_exists") ||
    m.includes("duplicate") ||
    m.includes("write_failed_due_to_invalid_input")
  );
}

// Seed the V1 baseline tuples under v1ModelId. Idempotent: read existing first,
// write only the missing ones in small batches; on a batch error fall back to
// one-by-one and swallow duplicate errors so the bootstrap never fails just
// because tuples already exist. Logs written vs skipped.
async function seedTuples(apiUrl, token, storeId, v1ModelId) {
  const all = buildV1Tuples();
  const existing = await readExistingTupleKeys(apiUrl, token, storeId);
  const missing = all.filter(
    (t) => !existing.has(t.user + "|" + t.relation + "|" + t.object),
  );
  const skipped = all.length - missing.length;
  console.log(
    "[openfga-seed] " + all.length + " V1 baseline tuples; " +
    missing.length + " missing, " + skipped + " already present",
  );
  if (missing.length === 0) {
    console.log("[openfga-seed] nothing to write; store already seeded");
    return { written: 0, skipped: skipped, total: all.length };
  }
  const BATCH = 50;
  let written = 0;
  let swallowed = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH);
    try {
      await fga(apiUrl, token, "POST", "/stores/" + storeId + "/write", {
        authorization_model_id: v1ModelId,
        writes: { tuple_keys: slice },
      });
      written += slice.length;
    } catch (batchErr) {
      // A racing tuple (or read-diff miss) failed the whole batch — retry
      // one-by-one and swallow duplicate errors so re-deploys stay safe.
      if (!isDuplicateWriteError(batchErr)) {
        console.log(
          "[openfga-seed] batch failed (" +
          String((batchErr && batchErr.message) || batchErr) +
          "); retrying one-by-one",
        );
      }
      for (const t of slice) {
        try {
          await fga(apiUrl, token, "POST", "/stores/" + storeId + "/write", {
            authorization_model_id: v1ModelId,
            writes: { tuple_keys: [t] },
          });
          written += 1;
        } catch (oneErr) {
          if (isDuplicateWriteError(oneErr)) {
            swallowed += 1;
          } else {
            throw oneErr;
          }
        }
      }
    }
    console.log("[openfga-seed] progress " + written + "/" + missing.length + " written");
  }
  console.log(
    "[openfga-seed] done: " + written + " written, " +
    (skipped + swallowed) + " skipped (" + skipped + " pre-present + " +
    swallowed + " duplicate-on-write), " + all.length + " total baseline",
  );
  return { written: written, skipped: skipped + swallowed, total: all.length };
}

exports.handler = async (event) => {
  const props = event.ResourceProperties || {};
  const physicalResourceId = event.PhysicalResourceId || ("openfga-bootstrap-" + props.storeName);
  if (event.RequestType === "Delete") {
    // No-op: deleting the store would orphan every tuple.
    return { PhysicalResourceId: physicalResourceId };
  }

  const apiUrl = props.apiUrl;
  const storeName = props.storeName;
  const keySecret = await getSecretJson(props.apiKeySecretArn);
  const token = keySecret.key;
  if (!token) throw new Error("preshared key secret missing 'key'");

  const storeId = await findOrCreateStore(apiUrl, token, storeName);
  const v1ModelId = await writeModel(apiUrl, token, storeId, V1_MODEL);
  const v2ModelId = await writeModel(apiUrl, token, storeId, V2_MODEL);

  // Seed the V1 baseline permission tuples (the gateway CHECK path) under the
  // V1 model on EVERY deploy. Without this the store has the right relations
  // but ZERO grant tuples, so every requirePermission() check returns a clean
  // allowed:false -> 403 (lo-home, agui/stream, etc.). Idempotent + in-VPC +
  // token-authed, so a fresh prod store self-seeds on the first deploy with no
  // manual steps. Runs after the model write so the grants validate against it.
  const seedResult = await seedTuples(apiUrl, token, storeId, v1ModelId);

  // Merge the real values into the existing openfga provider secret,
  // overwriting the pipeline's placeholder seed. PRESERVE any other keys.
  const current = await getSecretJson(props.providerSecretArn);
  const next = {
    ...current,
    apiUrl,
    storeId,
    // OPENFGA_MODEL_ID (the gateway CHECK path) -> the V1 model.
    modelId: v1ModelId,
    // OPENFGA_CANONICAL_MODEL_ID (the V2 sync engine) -> the V2 model.
    canonicalModelId: v2ModelId,
    apiToken: token,
  };
  await sm.send(new PutSecretValueCommand({
    SecretId: props.providerSecretArn,
    SecretString: JSON.stringify(next),
  }));

  return {
    PhysicalResourceId: physicalResourceId,
    Data: {
      storeId,
      v1ModelId,
      v2ModelId,
      apiUrl,
      tuplesWritten: String(seedResult.written),
      tuplesSkipped: String(seedResult.skipped),
      tuplesTotal: String(seedResult.total),
    },
  };
};
`;
