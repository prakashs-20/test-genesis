import * as cdk from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";

export class KmsKeys extends Construct {
  public readonly rdsKey: kms.Key;
  public readonly s3Key: kms.Key;
  public readonly opensearchKey: kms.Key;
  public readonly piiKey: kms.Key;

  constructor(scope: Construct, id: string, config: EnvironmentConfig) {
    super(scope, id);

    // RDS encryption key (tenant-specific CMK)
    this.rdsKey = new kms.Key(this, "RdsKey", {
      alias: `axira/${config.env}/rds`,
      description: `Axira ${config.env} - RDS encryption key`,
      enableKeyRotation: true, // Annual auto-rotation
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // S3 encryption key (bucket-level CMK)
    this.s3Key = new kms.Key(this, "S3Key", {
      alias: `axira/${config.env}/s3`,
      description: `Axira ${config.env} - S3 encryption key`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // OpenSearch encryption key (domain CMK)
    this.opensearchKey = new kms.Key(this, "OpenSearchKey", {
      alias: `axira/${config.env}/opensearch`,
      description: `Axira ${config.env} - OpenSearch encryption key`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // PII field-level encryption key (tenant-specific CMK)
    this.piiKey = new kms.Key(this, "PiiKey", {
      alias: `axira/${config.env}/pii`,
      description: `Axira ${config.env} - PII field-level encryption key`,
      enableKeyRotation: true,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });
  }
}
