// S3 buckets for documents, evidence, exports, assets, ALB logs, and audit exports.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  RemovalPolicy,
  CfnOutput,
  aws_kms as kms,
  aws_s3 as s3,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig, BucketDef } from "./config.js";

export class StorageStack extends cdk.Stack {
  public readonly buckets: Record<string, s3.Bucket> = {};

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    key: kms.IKey,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    for (const def of envCfg.buckets) {
      this.buckets[def.logicalId] = this.createBucket(envCfg, def, key);
    }

    for (const [name, bucket] of Object.entries(this.buckets)) {
      new CfnOutput(this, `Bucket-${name}-Name`, { value: bucket.bucketName });
    }
  }

  private createBucket(
    envCfg: EnvConfig,
    def: BucketDef,
    key: kms.IKey,
  ): s3.Bucket {
    const lifecycleRules = this.buildLifecycle(def);
    // Staging envs (axira-staging, genesis-staging) are still being iterated on,
    // so we treat them as dev — Object Lock disabled, buckets DESTROY-able.
    // Only prod envs (genesis-prod, axira-los) run with full Compliance-mode
    // locks and retained buckets.
    const isDev = !isProdEnv(envCfg.name);

    // Object Lock in Compliance mode (which BucketDef.objectLockYears implies
    // for evidence) cannot be bypassed by any principal — once an object is
    // written it survives for the retention period. That's correct for prod
    // but a footgun for staging, where rollbacks strand the bucket with locked
    // objects. Disable Object Lock in non-prod so autoDeleteObjects can clean
    // up on destroy.
    const objectLock = def.objectLockYears !== undefined && !isDev;

    const removalPolicy = this.bucketRemovalPolicy(envCfg, def);
    // autoDeleteObjects is only valid when the bucket is DESTROY-able. Keep
    // these two flags in lockstep so CDK validation doesn't reject the stack.
    const autoDeleteObjects = removalPolicy === RemovalPolicy.DESTROY;

    // ALB access-log delivery only supports SSE-S3 (AES-256) — KMS-encrypted
    // buckets are rejected by the ALB logging service. Use S3-managed
    // encryption for alb-logs and KMS for everything else.
    const useKms = def.logicalId !== "alb-logs";

    return new s3.Bucket(this, `Bucket-${def.logicalId}`, {
      bucketName: `axira-${envCfg.name}-${def.logicalId}-${this.account}`,
      encryption: useKms
        ? s3.BucketEncryption.KMS
        : s3.BucketEncryption.S3_MANAGED,
      encryptionKey: useKms ? key : undefined,
      bucketKeyEnabled: useKms,
      versioned: def.versioned,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectLockEnabled: objectLock,
      objectLockDefaultRetention: objectLock
        ? s3.ObjectLockRetention.compliance(
            Duration.days(365 * def.objectLockYears!),
          )
        : undefined,
      lifecycleRules,
      removalPolicy,
      autoDeleteObjects,
    });
  }

  private buildLifecycle(def: BucketDef): s3.LifecycleRule[] | undefined {
    const rules: s3.LifecycleRule[] = [];
    if (def.transitionToIaDays !== undefined) {
      rules.push({
        id: "ToIa",
        transitions: [
          {
            storageClass: s3.StorageClass.INFREQUENT_ACCESS,
            transitionAfter: Duration.days(def.transitionToIaDays),
          },
        ],
      });
    }
    if (def.expirationDays !== undefined) {
      rules.push({
        id: "Expire",
        expiration: Duration.days(def.expirationDays),
      });
    }

    rules.push({
      id: "AbortIncompleteMpu",
      abortIncompleteMultipartUploadAfter: Duration.days(7),
    });
    return rules.length ? rules : undefined;
  }

  private bucketRemovalPolicy(
    envCfg: EnvConfig,
    def: BucketDef,
  ): RemovalPolicy {
    // Staging envs (axira-staging, genesis-staging) are dev/test: every
    // bucket is DESTROY-able so rollbacks and `cdk destroy` clean up
    // properly. Object Lock is disabled in these envs (see createBucket),
    // so Compliance-mode locks don't block destroy.
    if (!isProdEnv(envCfg.name)) return RemovalPolicy.DESTROY;

    // prod envs: object-locked buckets, audit-exports, and everything
    // else all retain — production data and compliance archives must survive
    // any accidental destroy. (Currently all branches return RETAIN; kept
    // separate to allow per-bucket tuning later.)
    if (def.objectLockYears !== undefined) return RemovalPolicy.RETAIN;
    if (def.logicalId === "audit-exports") return RemovalPolicy.RETAIN;
    return RemovalPolicy.RETAIN;
  }
}
