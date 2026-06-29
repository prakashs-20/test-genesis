import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import type { NetworkStack } from "./network-stack.js";

export class DatabaseStack extends cdk.Stack {
  public readonly dbInstance: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.Secret;
  public readonly redisEndpoint: string;
  public readonly opensearchDomain: opensearch.Domain;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    network: NetworkStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    // --- RDS PostgreSQL 16 ---

    this.dbSecret = new secretsmanager.Secret(this, "DbCredentials", {
      secretName: `axira/${config.env}/rds/credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "axira_admin" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    const parameterGroup = new rds.ParameterGroup(this, "PgParams", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      parameters: {
        shared_preload_libraries: "pg_stat_statements,vector",
        log_min_duration_statement: "1000",
        max_connections: "200",
        work_mem: "64MB",
        maintenance_work_mem: "256MB",
        effective_cache_size: "4GB",
      },
    });

    this.dbInstance = new rds.DatabaseInstance(this, "AxiraDb", {
      instanceIdentifier: `axira-${config.env}-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(config.rds.instanceClass),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(this.dbSecret),
      databaseName: "axira",
      multiAz: config.rds.multiAz,
      allocatedStorage: config.rds.allocatedStorage,
      maxAllocatedStorage: config.rds.maxAllocatedStorage,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(config.rds.backupRetention),
      deletionProtection: config.rds.deletionProtection,
      parameterGroup,
      monitoringInterval: cdk.Duration.seconds(60),
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // --- ElastiCache Redis 7 ---

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      "RedisSubnetGroup",
      {
        description: `Axira ${config.env} Redis subnet group`,
        subnetIds: network.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
        cacheSubnetGroupName: `axira-${config.env}-redis`,
      },
    );

    if (config.redis.multiAz) {
      const redisCluster = new elasticache.CfnReplicationGroup(
        this,
        "RedisReplication",
        {
          replicationGroupDescription: `Axira ${config.env} Redis cluster`,
          engine: "redis",
          engineVersion: "7.1",
          cacheNodeType: config.redis.nodeType,
          numCacheClusters: config.redis.numCacheNodes,
          automaticFailoverEnabled: true,
          multiAzEnabled: true,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName!,
          securityGroupIds: [network.cacheSecurityGroup.securityGroupId],
          atRestEncryptionEnabled: true,
          transitEncryptionEnabled: true,
        },
      );
      this.redisEndpoint = redisCluster.attrPrimaryEndPointAddress;
    } else {
      const redisCluster = new elasticache.CfnCacheCluster(
        this,
        "RedisCluster",
        {
          clusterName: `axira-${config.env}-redis`,
          engine: "redis",
          engineVersion: "7.1",
          cacheNodeType: config.redis.nodeType,
          numCacheNodes: 1,
          cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName!,
          vpcSecurityGroupIds: [network.cacheSecurityGroup.securityGroupId],
        },
      );
      this.redisEndpoint = redisCluster.attrRedisEndpointAddress;
    }

    // --- OpenSearch 2.17 ---

    this.opensearchDomain = new opensearch.Domain(this, "AxiraSearch", {
      domainName: `axira-${config.env}`,
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      vpc: network.vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      securityGroups: [network.searchSecurityGroup],
      capacity: {
        dataNodeInstanceType: config.opensearch.dataNodeInstanceType,
        dataNodes: config.opensearch.dataNodeCount,
        ...(config.opensearch.masterNodeCount > 0 && {
          masterNodeInstanceType: config.opensearch.masterNodeInstanceType,
          masterNodes: config.opensearch.masterNodeCount,
        }),
      },
      ebs: {
        volumeSize: config.opensearch.ebsVolumeSize,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      encryptionAtRest: { enabled: true },
      nodeToNodeEncryption: true,
      enforceHttps: true,
      logging: {
        slowSearchLogEnabled: true,
        appLogEnabled: true,
        slowIndexLogEnabled: true,
      },
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });
  }
}
