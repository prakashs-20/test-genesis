// Aurora Postgres Serverless v2, ElastiCache Redis, and OpenSearch domain for the platform.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_rds as rds,
  aws_elasticache as elasticache,
  aws_opensearchservice as opensearch,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";
import type { SecretsStack } from "./secrets-stack.js";

export class DatabaseStack extends cdk.Stack {
  public readonly auroraCluster: rds.DatabaseCluster;
  public readonly auroraReaderEndpoint: string;
  public readonly redis: elasticache.CfnReplicationGroup;
  public readonly opensearch: opensearch.Domain;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    shared: SharedProps,
    secrets: SecretsStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const isolatedSubnets = shared.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    // rds.force_ssl=1 is the production posture: Aurora rejects any
    // non-TLS connection. axira-staging relaxes this to "0" because the
    // Temporal auto-setup image's TLS env-var support is inconsistent
    // across 1.2x versions and forcing TLS makes Temporal's persistence
    // pool unable to bootstrap. Other clients (gateway / runtime / engine)
    // can still negotiate TLS via the standard postgres driver — the
    // setting only relaxes the SERVER's hard requirement.
    // Temporal's persistence pool can't negotiate TLS reliably against
    // Aurora through the auto-setup image's env-var passthrough. Only
    // genesis-prod runs with force_ssl=1; staging envs relax it during
    // bring-up so the temporal-server starts. Revisit when the Temporal
    // image's TLS handling is verified.
    const requireSsl = isProdEnv(envCfg.name);
    const clusterParameterGroup = new rds.ParameterGroup(
      this,
      "AuroraClusterParams",
      {
        engine: rds.DatabaseClusterEngine.auroraPostgres({
          version: rds.AuroraPostgresEngineVersion.VER_16_4,
        }),
        parameters: {
          shared_preload_libraries: "pg_stat_statements,pgaudit",
          "rds.force_ssl": requireSsl ? "1" : "0",
          "pgaudit.log": "ddl,role",
        },
      },
    );

    const writer = rds.ClusterInstance.serverlessV2("Writer", {
      parameterGroup: rds.ParameterGroup.fromParameterGroupName(
        this,
        "WriterPg",
        "default.aurora-postgresql16",
      ),
    });

    const readers: rds.IClusterInstance[] = [];
    for (let i = 0; i < envCfg.postgres.replicaCount; i += 1) {
      readers.push(
        rds.ClusterInstance.serverlessV2(`Reader${i + 1}`, {
          scaleWithWriter: true,
        }),
      );
    }

    // Import the master credentials secret instead of passing the live
    // SecretsStack reference. `rds.Credentials.fromSecret(liveSecret)` makes
    // CDK create a `SecretTargetAttachment` as a child of the live secret
    // (which is in SecretsStack) referencing this cluster's id — that
    // produces SecretsStack -> DatabaseStack. Combined with Aurora using
    // appKey for storage encryption (DatabaseStack -> SecretsStack via KMS
    // arn), the stack graph cycles. Using an imported ISecret avoids the
    // attachment being added in SecretsStack.
    const importedAppDbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      "ImportedAppDbSecret",
      secrets.appDbSecret.secretArn,
    );

    this.auroraCluster = new rds.DatabaseCluster(this, "Aurora", {
      clusterIdentifier: `axira-${envCfg.name}-aurora`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer,
      readers,
      serverlessV2MinCapacity: envCfg.postgres.auroraMinAcu,
      serverlessV2MaxCapacity: envCfg.postgres.auroraMaxAcu,
      vpc: shared.vpc,
      vpcSubnets: isolatedSubnets,
      securityGroups: [shared.dbSg!],
      credentials: rds.Credentials.fromSecret(importedAppDbSecret),
      defaultDatabaseName: "axira",
      backup: {
        retention: Duration.days(envCfg.postgres.backupRetentionDays),
        preferredWindow: "07:00-08:00",
      },
      deletionProtection: envCfg.postgres.deletionProtection,
      cloudwatchLogsExports: ["postgresql"],
      parameterGroup: clusterParameterGroup,
      storageEncrypted: true,
      storageEncryptionKey: secrets.appKey,
      iamAuthentication: true,
      removalPolicy: envCfg.postgres.deletionProtection
        ? RemovalPolicy.SNAPSHOT
        : RemovalPolicy.DESTROY,
    });

    this.auroraReaderEndpoint = this.auroraCluster.clusterReadEndpoint.hostname;

    // Automatic password rotation is intentionally NOT configured here.
    // `auroraCluster.addRotationSingleUser()` creates a rotation Lambda whose
    // SG needs ingress on the cluster's SG (`dbSg`). Because `dbSg` lives in
    // NetworkStack, that ingress rule causes NetworkStack -> DatabaseStack —
    // and combined with DatabaseStack -> NetworkStack via VPC subnets, the
    // stack graph cycles.
    //
    // Options to add rotation later, in order of preference:
    //   1. Move `dbSg` into DatabaseStack so all SG mutations stay in one
    //      stack. Requires NetworkStack to no longer own dbSg; SharedProps
    //      gains it from DatabaseStack instead.
    //   2. Define the rotation Lambda's SG in NetworkStack, then construct
    //      a manual `secretsmanager.SecretRotation` in DatabaseStack passing
    //      that SG, so the ingress rule stays cross-stack-clean.
    //   3. Enable rotation in the AWS console after deploy. The hosted
    //      rotation template is `SecretsManager/PostgreSQLSingleUser` —
    //      schedule = 30 days.

    const cacheSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "CacheSubnets",
      {
        description: `${envCfg.name} Redis subnets`,
        subnetIds: isolatedSubnets.subnetIds,
      },
    );

    const numNodes = 1 + envCfg.redis.replicasPerShard;
    this.redis = new elasticache.CfnReplicationGroup(this, "Redis", {
      replicationGroupId: `axira-${envCfg.name}-redis`,
      replicationGroupDescription: `axira ${envCfg.name} redis`,
      engine: "redis",
      engineVersion: "7.1",
      cacheNodeType: envCfg.redis.nodeType,
      numCacheClusters: numNodes,
      automaticFailoverEnabled: envCfg.redis.replicasPerShard > 0,
      multiAzEnabled: envCfg.redis.multiAz,
      cacheSubnetGroupName: cacheSubnetGroup.ref,
      securityGroupIds: [shared.cacheSg!.securityGroupId],
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      kmsKeyId: secrets.appKey.keyArn,
      snapshotRetentionLimit: envCfg.redis.snapshotRetentionDays,
    });

    this.opensearch = new opensearch.Domain(this, "OpenSearch", {
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      domainName: `axira-${envCfg.name}`,
      capacity: {
        dataNodes: envCfg.opensearch.dataNodeCount,
        dataNodeInstanceType: envCfg.opensearch.dataNodeInstanceType,
        masterNodes: envCfg.opensearch.masterNodeCount,
        masterNodeInstanceType: envCfg.opensearch.masterNodeInstanceType,
        warmNodes: envCfg.opensearch.warmStorage ? 2 : 0,
      },
      ebs: {
        volumeSize: envCfg.opensearch.volumeGiB,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      vpc: shared.vpc,
      vpcSubnets: [isolatedSubnets],
      securityGroups: [shared.searchSg!],
      zoneAwareness: envCfg.opensearch.multiAz
        ? {
            enabled: true,
            availabilityZoneCount: Math.min(envCfg.opensearch.dataNodeCount, 3),
          }
        : undefined,
      encryptionAtRest: { enabled: true, kmsKey: secrets.appKey },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      logging: {
        slowSearchLogEnabled: true,
        slowIndexLogEnabled: true,
        appLogEnabled: true,
      },
      removalPolicy: envCfg.postgres.deletionProtection
        ? RemovalPolicy.SNAPSHOT
        : RemovalPolicy.DESTROY,
    });

    // Domain-level resource (access) policy. A VPC OpenSearch domain with NO
    // access policy applies a restrictive default that denies EVERY request —
    // including IAM-signed ones — with
    //   "User: anonymous is not authorized to perform: es:ESHttp* because no
    //    resource-based policy allows the es:ESHttp* action".
    // The platform clients (gateway observability routes, v3 search/actions,
    // knowledge spine indexer, timeline federation) speak raw HTTP over the
    // private subnet and do NOT SigV4-sign (see packages/opensearch-client:
    // "within the cluster the gateway reaches OpenSearch over a private
    // subnet"). Security is the VPC + the domain security group (searchSg only
    // admits the ECS service SG). So the correct posture for this VPC-only,
    // FGAC-disabled domain is an open-in-VPC anonymous allow of es:ESHttp* on
    // domain/<name>/*. Reachability is still gated by the SG, not by IAM.
    // Parameterized via the domain ARN, so every env (incl. genesis-prod) gets
    // the identical policy. Use a `domain/*` wildcard resource to avoid the
    // construct-time circular reference on the domain's own ARN.
    this.opensearch.addAccessPolicies(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ["es:ESHttp*"],
        resources: [`${this.opensearch.domainArn}/*`],
      }),
    );

    new CfnOutput(this, "AuroraClusterEndpoint", {
      value: this.auroraCluster.clusterEndpoint.hostname,
    });
    new CfnOutput(this, "AuroraReaderEndpoint", {
      value: this.auroraReaderEndpoint,
    });
    new CfnOutput(this, "RedisEndpoint", {
      value: this.redis.attrPrimaryEndPointAddress,
    });
    new CfnOutput(this, "RedisPort", {
      value: this.redis.attrPrimaryEndPointPort,
    });
    new CfnOutput(this, "OpenSearchEndpoint", {
      value: this.opensearch.domainEndpoint,
    });
  }
}
