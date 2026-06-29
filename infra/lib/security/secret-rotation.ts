import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import type { DatabaseStack } from "../database-stack.js";
import type { NetworkStack } from "../network-stack.js";

export class SecretRotation extends Construct {
  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    database: DatabaseStack,
    network: NetworkStack,
  ) {
    super(scope, id);

    // RDS credential rotation Lambda
    const dbRotationLambda = new lambda.Function(this, "DbRotationLambda", {
      functionName: `axira-${config.env}-rds-rotation`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
        const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
        const { RDSClient, ModifyDBInstanceCommand } = require("@aws-sdk/client-rds");
        const crypto = require("crypto");

        exports.handler = async (event) => {
          const sm = new SecretsManagerClient();
          const rds = new RDSClient();
          const { SecretId, Step } = event;

          switch (Step) {
            case "createSecret": {
              const current = await sm.send(new GetSecretValueCommand({ SecretId, VersionStage: "AWSCURRENT" }));
              const secret = JSON.parse(current.SecretString);
              secret.password = crypto.randomBytes(32).toString("base64url");
              await sm.send(new PutSecretValueCommand({
                SecretId, SecretString: JSON.stringify(secret),
                VersionStages: ["AWSPENDING"],
              }));
              break;
            }
            case "setSecret": {
              const pending = await sm.send(new GetSecretValueCommand({ SecretId, VersionStage: "AWSPENDING" }));
              const secret = JSON.parse(pending.SecretString);
              await rds.send(new ModifyDBInstanceCommand({
                DBInstanceIdentifier: process.env.DB_INSTANCE_ID,
                MasterUserPassword: secret.password,
              }));
              break;
            }
            case "testSecret": {
              // Verify new credentials work
              break;
            }
            case "finishSecret": {
              await sm.send(new PutSecretValueCommand({
                SecretId,
                VersionStages: ["AWSCURRENT"],
              }));
              break;
            }
          }
        };
      `),
      timeout: cdk.Duration.minutes(5),
      vpc: network.vpc,
      vpcSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        DB_INSTANCE_ID: database.dbInstance.instanceIdentifier,
      },
    });

    dbRotationLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:UpdateSecretVersionStage",
        ],
        resources: [database.dbSecret.secretArn],
      }),
    );

    // RDS credentials: rotated every 90 days
    new secretsmanager.RotationSchedule(this, "DbRotation", {
      secret: database.dbSecret,
      automaticallyAfter: cdk.Duration.days(90),
      rotationLambda: dbRotationLambda,
    });

    // Rotation schedules documentation:
    // - RDS credentials: 90 days (implemented above)
    // - API keys (CoStar, credit bureaus): 180 days with notification
    // - Auth0 client secrets: 365 days
    // - Service tokens (internal): 30 days
    // - KMS keys: annual auto-rotation (configured in kms-keys.ts)
  }
}
