// S3 + Kinesis Firehose + CloudWatch Logs subscription filters for the regulator-grade authorization audit archive.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_s3 as s3,
  aws_iam as iam,
  aws_kinesisfirehose as firehose,
  aws_logs as logs,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SecretsStack } from "./secrets-stack.js";

const SUBSCRIBED_SERVICES: ReadonlyArray<string> = [
  "axira-gateway",
  "axira-agent-runtime",
  "axira-workflow-engine",
];

const FILTER_PATTERN =
  '{ $.message = "am_decision" || $.message = "cap_authz_decision" || $.message = "authorization_decision" }';

export class AuditArchiveStack extends cdk.Stack {
  public readonly archiveBucket: s3.Bucket;
  public readonly deliveryStream: firehose.CfnDeliveryStream;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    secrets: SecretsStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const isProd = isProdEnv(envCfg.name);
    // Staging envs (axira-staging, genesis-staging) are still being iterated
    // on — make the archive bucket destroyable so rollbacks don't strand it.
    // Object Lock is in Governance mode for non-prod (bypass-on-delete
    // allowed), so autoDeleteObjects can clear contents.
    const isDev = !isProd;

    this.archiveBucket = new s3.Bucket(this, "ArchiveBucket", {
      bucketName: `axira-${envCfg.name}-am-audit-archive${envCfg.auditArchiveSuffix ? `-${envCfg.auditArchiveSuffix}` : ""}-${this.account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: secrets.appKey,
      bucketKeyEnabled: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: isProd
        ? s3.ObjectLockRetention.compliance(Duration.days(365 * 7))
        : s3.ObjectLockRetention.governance(Duration.days(90)),
      lifecycleRules: [
        {
          id: "ToGlacierDeepArchive",
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: Duration.days(90),
            },
          ],
        },
        {
          id: "Expire",
          expiration: Duration.days(365 * 7),
        },
        {
          id: "AbortIncompleteMpu",
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      // axira-staging is dev/test: make the bucket destroyable so rollbacks
      // don't strand it (Object Lock is "Governance" mode here, which allows
      // bypass-on-delete, so autoDeleteObjects can clear contents). Genesis
      // environments stay RETAIN — production audit data must survive any
      // accidental destroy.
      removalPolicy: isDev ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
      autoDeleteObjects: isDev,
    });

    const firehoseRole = new iam.Role(this, "FirehoseRole", {
      roleName: `axira-${envCfg.name}-am-audit-firehose-role`,
      assumedBy: new iam.ServicePrincipal("firehose.amazonaws.com"),
      description: "Firehose delivery role for the AM audit archive stream",
    });
    this.archiveBucket.grantReadWrite(firehoseRole);
    secrets.appKey.grantEncryptDecrypt(firehoseRole);

    const firehoseLogGroup = new logs.LogGroup(this, "FirehoseLogs", {
      logGroupName: `/axira/${envCfg.name}/firehose/am-audit-archive`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: secrets.appKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    firehoseLogGroup.grantWrite(firehoseRole);

    this.deliveryStream = new firehose.CfnDeliveryStream(
      this,
      "DeliveryStream",
      {
        deliveryStreamName: `axira-${envCfg.name}-am-audit-firehose`,
        deliveryStreamType: "DirectPut",
        extendedS3DestinationConfiguration: {
          bucketArn: this.archiveBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: { sizeInMBs: 5, intervalInSeconds: 300 },
          compressionFormat: "GZIP",
          encryptionConfiguration: {
            kmsEncryptionConfig: { awskmsKeyArn: secrets.appKey.keyArn },
          },
          prefix:
            "am-audit/env=" +
            envCfg.name +
            "/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/",
          errorOutputPrefix:
            "errors/env=" +
            envCfg.name +
            "/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/!{firehose:error-output-type}/",
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: "S3Delivery",
          },
        },
      },
    );

    // Inline the firehose write permission directly in the role definition
    // rather than calling `.addToPolicy()` afterward. Two reasons:
    //
    //   1. Atomic create — the role and its policy are a single CFN resource,
    //      so the role is never visible without the policy attached.
    //
    //   2. CloudWatch's subscription-filter creation sends a "test record"
    //      to Firehose using this role. If the policy is a separate
    //      AWS::IAM::Policy resource that hasn't propagated through IAM's
    //      eventually-consistent cache yet, the test fires with
    //      "is not authorized to perform firehose:PutRecord". Inline
    //      policies attached at role-creation time don't race.
    const cwLogsRole = new iam.Role(this, "CwLogsRole", {
      roleName: `axira-${envCfg.name}-am-audit-cwlogs-role`,
      assumedBy: new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
      description: "Allows CloudWatch Logs to forward records to Firehose",
      inlinePolicies: {
        FirehosePutRecord: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["firehose:PutRecord", "firehose:PutRecordBatch"],
              resources: [this.deliveryStream.attrArn],
            }),
          ],
        }),
      },
    });

    for (const svc of SUBSCRIBED_SERVICES) {
      const filter = new logs.CfnSubscriptionFilter(this, `Filter-${svc}`, {
        logGroupName: `/axira/${envCfg.name}/${svc}`,
        filterName: `axira-${envCfg.name}-${svc}-am-audit`,
        filterPattern: FILTER_PATTERN,
        destinationArn: this.deliveryStream.attrArn,
        roleArn: cwLogsRole.roleArn,
      });
      // Explicit dependency belt-and-suspenders: even though the role
      // includes its policy inline, ensure CFN orders the filter strictly
      // after the role exists.
      filter.node.addDependency(cwLogsRole);
    }

    new CfnOutput(this, "ArchiveBucketName", {
      value: this.archiveBucket.bucketName,
    });
    new CfnOutput(this, "DeliveryStreamArn", {
      value: this.deliveryStream.attrArn,
    });
  }
}
