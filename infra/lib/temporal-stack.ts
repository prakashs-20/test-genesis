import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import type { NetworkStack } from "./network-stack.js";

export class TemporalStack extends cdk.Stack {
  public readonly temporalEndpoint: string;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    network: NetworkStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    // Temporal's own PostgreSQL (separate from app DB)
    const temporalDbSecret = new secretsmanager.Secret(
      this,
      "TemporalDbSecret",
      {
        secretName: `axira/${config.env}/temporal/db-credentials`,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: "temporal_admin" }),
          generateStringKey: "password",
          excludePunctuation: true,
          passwordLength: 32,
        },
      },
    );

    const temporalDb = new rds.DatabaseInstance(this, "TemporalDb", {
      instanceIdentifier: `axira-${config.env}-temporal-db`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType: new ec2.InstanceType(config.temporal.dbInstanceClass),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.dbSecurityGroup],
      credentials: rds.Credentials.fromSecret(temporalDbSecret),
      databaseName: "temporal",
      allocatedStorage: 50,
      maxAllocatedStorage: 200,
      storageEncrypted: true,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // ECS cluster for Temporal
    const cluster = new ecs.Cluster(this, "TemporalCluster", {
      clusterName: `axira-${config.env}-temporal`,
      vpc: network.vpc,
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "TemporalNamespace",
      {
        name: `temporal.${config.env}.axiralabs.internal`,
        vpc: network.vpc,
      },
    );

    const temporalTaskDef = new ecs.FargateTaskDefinition(
      this,
      "TemporalTask",
      {
        cpu: config.temporal.cpu,
        memoryLimitMiB: config.temporal.memory,
      },
    );

    temporalTaskDef.addContainer("temporal", {
      image: ecs.ContainerImage.fromRegistry("temporalio/auto-setup:1.26"),
      environment: {
        DB: "postgresql",
        DB_PORT: "5432",
        POSTGRES_SEEDS: temporalDb.instanceEndpoint.hostname,
        NUM_HISTORY_SHARDS: "512",
      },
      secrets: {
        POSTGRES_USER: ecs.Secret.fromSecretsManager(
          temporalDbSecret,
          "username",
        ),
        POSTGRES_PWD: ecs.Secret.fromSecretsManager(
          temporalDbSecret,
          "password",
        ),
      },
      portMappings: [
        { containerPort: 7233, protocol: ecs.Protocol.TCP },
        { containerPort: 7234, protocol: ecs.Protocol.TCP },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "temporal",
        logRetention: logs.RetentionDays.THIRTY_DAYS,
      }),
    });

    new ecs.FargateService(this, "TemporalService", {
      cluster,
      taskDefinition: temporalTaskDef,
      desiredCount: config.temporal.serverCount,
      securityGroups: [network.ecsSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      cloudMapOptions: {
        name: "server",
        dnsRecordType: servicediscovery.DnsRecordType.A,
        cloudMapNamespace: namespace,
      },
    });

    this.temporalEndpoint = `server.temporal.${config.env}.axiralabs.internal:7233`;

    // Temporal UI
    const uiTaskDef = new ecs.FargateTaskDefinition(this, "TemporalUiTask", {
      cpu: 256,
      memoryLimitMiB: 512,
    });
    uiTaskDef.addContainer("ui", {
      image: ecs.ContainerImage.fromRegistry("temporalio/ui:2.34"),
      environment: {
        TEMPORAL_ADDRESS: this.temporalEndpoint,
        TEMPORAL_CORS_ORIGINS: `https://${config.domainName}`,
      },
      portMappings: [{ containerPort: 8080, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "temporal-ui",
        logRetention: logs.RetentionDays.THIRTY_DAYS,
      }),
    });
  }
}
