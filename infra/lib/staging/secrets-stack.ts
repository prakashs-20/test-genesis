// Shared KMS CMK and Secrets Manager entries for provider credentials and database users.

import * as cdk from "aws-cdk-lib";
import {
  RemovalPolicy,
  CfnOutput,
  aws_iam as iam,
  aws_kms as kms,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";

export class SecretsStack extends cdk.Stack {
  public readonly appKey: kms.Key;
  public readonly providerSecrets: Record<string, secretsmanager.Secret> = {};
  public readonly appDbSecret: secretsmanager.Secret;
  public readonly temporalDbSecret: secretsmanager.Secret;
  public readonly serviceTokenSecret: secretsmanager.Secret;
  public readonly alertRunnerServiceTokenSecret: secretsmanager.Secret;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.appKey = new kms.Key(this, "AppKey", {
      alias: `alias/axira-${envCfg.name}-app`,
      description: `Axira ${envCfg.name} master CMK`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Allow CloudWatch Logs service to use this key for any log group in
    // this account/region. Without this, log groups in other stacks that
    // pass `encryptionKey: secrets.appKey` fail to create with
    // "KMS key not allowed to be used with [log-group ARN]".
    //
    // CDK normally adds a per-log-group grant via `key.addToResourcePolicy()`
    // when you pass the live `kms.Key` to a `logs.LogGroup`. Cross-stack,
    // that statement would reference a remote log-group ARN — creating a
    // SecretsStack <-> consumer-stack cycle. Adding the grant statically
    // here, scoped to this account/region without naming any consumer
    // resource, breaks the cycle while keeping encryption tight.
    this.appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowCloudWatchLogsServicePrincipalToUseKey",
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`),
        ],
        actions: [
          "kms:Encrypt*",
          "kms:Decrypt*",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:Describe*",
        ],
        resources: ["*"],
        conditions: {
          ArnLike: {
            "kms:EncryptionContext:aws:logs:arn": `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    // Allow Kinesis Firehose (used by AuditArchiveStack) to use the key for
    // encrypting records before they're written to S3. Same rationale as
    // CloudWatch Logs above — cross-stack grants would cycle.
    this.appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowFirehoseServicePrincipalToUseKey",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("firehose.amazonaws.com")],
        actions: ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
        resources: ["*"],
        conditions: {
          StringEquals: { "kms:CallerAccount": this.account },
        },
      }),
    );

    // Let the GitHub-Actions OIDC deploy role use this CMK so the pipeline's
    // direct Secrets-Manager calls on CMK-encrypted secrets succeed.
    //
    // The deploy role (`AWS_DEPLOY_ROLE`, default name `axira-github-deploy`)
    // is NOT created by this CDK app — it's a pre-existing OIDC role in the
    // target account. It carries the AWS-managed `SecretsManagerReadWrite`
    // policy, which grants `secretsmanager:*` but, deliberately, only
    // `kms:DescribeKey/ListAliases/ListKeys` — NOT `kms:Decrypt` or
    // `kms:GenerateDataKey`. So when a deploy step calls `get-secret-value`
    // (auth0_setup) or `put-secret-value` (seed_secrets) on a secret encrypted
    // with THIS customer-managed CMK, Secrets Manager's KMS call is denied
    // ("Access to KMS is not allowed") even though the secretsmanager action
    // itself is allowed. The account-root `kms:ViaService=secretsmanager`
    // statements CDK adds only delegate to the account; they still require the
    // caller's identity policy to grant the KMS action, which the managed
    // policy does not.
    //
    // Granting via the KEY POLICY here (a direct resource-policy statement,
    // since CDK can't mutate an external role's identity policy) makes the
    // deploy role able to decrypt+encrypt WITHOUT relying on its identity
    // policy, and is env-agnostic: every env (genesis-prod included) that runs
    // this stack inherits it, so the same first-deploy KMS failure can't recur
    // for seed_secrets/auth0_setup. Encrypt+Decrypt (not just Decrypt) so the
    // fresh-env `put-secret-value` seed path (needs GenerateDataKey) is covered
    // too, not only the `get-secret-value` read path.
    //
    // Override the role NAME via CDK_DEPLOY_ROLE_NAME for customer accounts
    // whose OIDC role isn't named `axira-github-deploy`, or the full ARN via
    // CDK_DEPLOY_ROLE_ARN. Defaults to the Axira-owned `axira-github-deploy`.
    //
    // Add the statement DIRECTLY to the key's resource policy (the same pattern
    // the CloudWatch-Logs / Firehose service grants above use). We deliberately
    // do NOT use `appKey.grantEncryptDecrypt(importedRole)`: for a role imported
    // from another stack/account with `mutable:false`, CDK's grant() resolves
    // against the key's account-root statement and adds NO resource statement
    // (silent no-op) — leaving the deploy role still unable to decrypt. An
    // explicit `addToResourcePolicy` with the role ARN as the principal is
    // deterministic and env-agnostic (genesis-prod inherits it).
    const deployRoleArn =
      process.env["CDK_DEPLOY_ROLE_ARN"] ??
      `arn:aws:iam::${this.account}:role/${process.env["CDK_DEPLOY_ROLE_NAME"] ?? "axira-github-deploy"}`;
    this.appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowGithubDeployRoleToUseKeyForSecrets",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(deployRoleArn)],
        // EncryptDecrypt (Decrypt for get-secret-value; Encrypt+GenerateDataKey
        // for the fresh-env put-secret-value seed path) + DescribeKey.
        actions: [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:ReEncrypt*",
          "kms:GenerateDataKey*",
          "kms:DescribeKey",
        ],
        resources: ["*"],
        // Scope to Secrets-Manager calls: the deploy role only ever touches
        // this CMK transitively through `secretsmanager:{get,put}-secret-value`.
        conditions: {
          StringEquals: {
            "kms:ViaService": `secretsmanager.${this.region}.amazonaws.com`,
          },
        },
      }),
    );

    for (const name of envCfg.providerSecrets) {
      this.providerSecrets[name] = new secretsmanager.Secret(
        this,
        `Secret-${name}`,
        {
          secretName: `axira/${envCfg.name}/${name}`,
          description: `${envCfg.name} credentials for ${name}`,
          encryptionKey: this.appKey,
        },
      );
    }

    this.appDbSecret = new secretsmanager.Secret(this, "AppDbSecret", {
      secretName: `axira/${envCfg.name}/postgres-app`,
      description: "Application Postgres master credentials",
      encryptionKey: this.appKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "axira_admin" }),
        generateStringKey: "password",
        excludePunctuation: true,
        passwordLength: 32,
      },
    });

    this.temporalDbSecret = new secretsmanager.Secret(
      this,
      "TemporalDbSecret",
      {
        secretName: `axira/${envCfg.name}/postgres-temporal`,
        description:
          "Temporal Postgres credentials (separate schema in Aurora cluster)",
        encryptionKey: this.appKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ username: "temporal_admin" }),
          generateStringKey: "password",
          excludePunctuation: true,
          passwordLength: 32,
        },
      },
    );

    // Rotation for appDbSecret is configured in DatabaseStack via
    // auroraCluster.addRotationSingleUser(). Defining it here would create a
    // SecretsStack -> DatabaseStack dependency (the hosted-rotation Lambda
    // needs the cluster's VPC/SG), and combined with Aurora using appKey for
    // storage encryption (DatabaseStack -> SecretsStack), it would cycle.

    this.serviceTokenSecret = new secretsmanager.Secret(
      this,
      "ServiceTokenSecret",
      {
        secretName: `axira/${envCfg.name}/service-token`,
        description:
          "HS256 shared secret minting + verifying service-to-service tokens across gateway, agent-runtime, workflow-engine, and cli.",
        encryptionKey: this.appKey,
        generateSecretString: {
          secretStringTemplate: JSON.stringify({}),
          generateStringKey: "secret",
          excludePunctuation: true,
          passwordLength: 64,
        },
      },
    );

    // Shared secret the gateway validates as ALERT_RUNNER_SERVICE_TOKEN and
    // the observability-alert-runner worker (ComputeStack) presents on its
    // service-token-gated `_evaluate` / `_run` calls. ONE generated value, read
    // by BOTH the gateway service and the runner so they always match. The
    // report-runner reuses the same token (it runs in the same runner pod).
    this.alertRunnerServiceTokenSecret = new secretsmanager.Secret(
      this,
      "AlertRunnerServiceTokenSecret",
      {
        secretName: `axira/${envCfg.name}/alert-runner-service-token`,
        description:
          "Shared service token: the gateway validates it as " +
          "ALERT_RUNNER_SERVICE_TOKEN; the observability-alert-runner presents " +
          "it on POST .../_evaluate and .../_run. Same value on both sides.",
        encryptionKey: this.appKey,
        generateSecretString: {
          // Plain string secret (no JSON key): the runner reads the whole
          // SecretString as ALERT_RUNNER_SERVICE_TOKEN and the gateway reads
          // the whole SecretString too — no JSON field to disagree on.
          passwordLength: 64,
          excludePunctuation: true,
        },
      },
    );

    new CfnOutput(this, "AppKeyArn", { value: this.appKey.keyArn });
    new CfnOutput(this, "AppKeyAlias", { value: this.appKey.keyId });
    new CfnOutput(this, "ServiceTokenSecretArn", {
      value: this.serviceTokenSecret.secretArn,
    });
    new CfnOutput(this, "AlertRunnerServiceTokenSecretArn", {
      value: this.alertRunnerServiceTokenSecret.secretArn,
    });
  }
}
