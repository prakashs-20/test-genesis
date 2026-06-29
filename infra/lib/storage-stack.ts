import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

export class StorageStack extends cdk.Stack {
  public readonly documentsBucket: s3.Bucket;
  public readonly artifactsBucket: s3.Bucket;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const bucketDefaults: Partial<s3.BucketProps> = {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: config.s3.versioning,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: config.env !== "production",
    };

    const lifecycleRules: s3.LifecycleRule[] = [];
    if (config.s3.iaTransitionDays > 0) {
      lifecycleRules.push({
        transitions: [
          {
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: cdk.Duration.days(config.s3.iaTransitionDays),
          },
          ...(config.s3.glacierTransitionDays > 0
            ? [
                {
                  storageClass: s3.StorageClass.GLACIER,
                  transitionAfter: cdk.Duration.days(
                    config.s3.glacierTransitionDays,
                  ),
                },
              ]
            : []),
        ],
      });
    }

    this.documentsBucket = new s3.Bucket(this, "Documents", {
      ...bucketDefaults,
      bucketName: `axira-${config.env}-documents`,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [
            s3.HttpMethods.GET,
            s3.HttpMethods.PUT,
            s3.HttpMethods.POST,
          ],
          allowedOrigins: [`https://${config.domainName}`],
          maxAge: 3600,
        },
      ],
      lifecycleRules,
    });

    this.artifactsBucket = new s3.Bucket(this, "Artifacts", {
      ...bucketDefaults,
      bucketName: `axira-${config.env}-artifacts`,
      lifecycleRules,
    });
  }
}
