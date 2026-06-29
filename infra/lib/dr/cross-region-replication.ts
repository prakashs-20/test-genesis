import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "../config.js";
import type { DatabaseStack } from "../database-stack.js";
import type { StorageStack } from "../storage-stack.js";

/**
 * Cross-Region Replication for DR (production only).
 *
 * - S3: cross-region replication to us-west-2
 * - RDS: read replica in us-west-2
 */
export class CrossRegionReplication extends Construct {
  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    database: DatabaseStack,
    storage: StorageStack,
  ) {
    super(scope, id);

    if (config.env !== "production") return;

    const drRegion = "us-west-2";

    // S3 cross-region replication
    const replicationRole = new iam.Role(this, "S3ReplicationRole", {
      assumedBy: new iam.ServicePrincipal("s3.amazonaws.com"),
    });

    // DR destination bucket (must exist in dr region - created separately or as part of a DR stack)
    const drDocumentsBucket = s3.Bucket.fromBucketName(
      this,
      "DrDocumentsBucket",
      "axira-dr-documents",
    );
    const drArtifactsBucket = s3.Bucket.fromBucketName(
      this,
      "DrArtifactsBucket",
      "axira-dr-artifacts",
    );

    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
        resources: [
          storage.documentsBucket.bucketArn,
          storage.artifactsBucket.bucketArn,
        ],
      }),
    );
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObjectVersionForReplication",
          "s3:GetObjectVersionAcl",
          "s3:GetObjectVersionTagging",
        ],
        resources: [
          `${storage.documentsBucket.bucketArn}/*`,
          `${storage.artifactsBucket.bucketArn}/*`,
        ],
      }),
    );
    replicationRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:ReplicateObject",
          "s3:ReplicateDelete",
          "s3:ReplicateTags",
        ],
        resources: [
          `${drDocumentsBucket.bucketArn}/*`,
          `${drArtifactsBucket.bucketArn}/*`,
        ],
      }),
    );

    // RDS read replica in us-west-2
    // Note: Cross-region read replica requires the DR VPC to exist in the target region
    // This is typically set up as a separate CDK stack deployed to us-west-2
    new cdk.CfnOutput(this, "DrRegion", {
      value: drRegion,
      description: "DR region for cross-region replication",
    });

    new cdk.CfnOutput(this, "DrReplicationRoleArn", {
      value: replicationRole.roleArn,
      description: "IAM role ARN for S3 cross-region replication",
    });
  }
}
