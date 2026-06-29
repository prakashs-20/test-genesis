import * as cdk from "aws-cdk-lib";
import * as config from "aws-cdk-lib/aws-config";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";

export class ComplianceRules extends Construct {
  constructor(scope: Construct, id: string, envConfig: EnvironmentConfig) {
    super(scope, id);

    // AWS Config managed rules for banking compliance
    new config.ManagedRule(this, "EncryptedVolumes", {
      identifier: "ENCRYPTED_VOLUMES",
      description: "Ensure all EBS volumes are encrypted",
    });

    new config.ManagedRule(this, "RdsEncryption", {
      identifier: "RDS_STORAGE_ENCRYPTED",
      description: "Ensure RDS storage is encrypted",
    });

    new config.ManagedRule(this, "S3BucketSSL", {
      identifier: "S3_BUCKET_SSL_REQUESTS_ONLY",
      description: "Ensure S3 buckets only accept SSL requests",
    });

    new config.ManagedRule(this, "VpcFlowLogs", {
      identifier: "VPC_FLOW_LOGS_ENABLED",
      description: "Ensure VPC flow logs are enabled",
    });

    new config.ManagedRule(this, "RootMFA", {
      identifier: "ROOT_ACCOUNT_MFA_ENABLED",
      description: "Ensure root account has MFA enabled",
    });

    new config.ManagedRule(this, "RdsMultiAz", {
      identifier: "RDS_MULTI_AZ_SUPPORT",
      description: "Ensure RDS instances have Multi-AZ enabled in production",
    });

    new config.ManagedRule(this, "CloudTrailEnabled", {
      identifier: "CLOUD_TRAIL_ENABLED",
      description: "Ensure CloudTrail is enabled",
    });

    // CloudTrail - audit trail for all API calls
    const auditBucket = new s3.Bucket(this, "AuditBucket", {
      bucketName: `axira-${envConfig.env}-audit-trail`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(365),
            },
          ],
          expiration: cdk.Duration.days(2555), // ~7 years for regulatory compliance
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cloudtrail.Trail(this, "AxiraTrail", {
      trailName: `axira-${envConfig.env}-audit`,
      bucket: auditBucket,
      sendToCloudWatchLogs: true,
      cloudWatchLogsRetention: logs.RetentionDays.TWO_YEARS,
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: envConfig.env === "production",
    });
  }
}
