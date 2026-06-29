#!/usr/bin/env node
// CDK App entrypoint for the Axira staging platform. Selects an environment via context and wires every stack together.

import * as cdk from "aws-cdk-lib";
import { Tags } from "aws-cdk-lib";

import { loadEnv, resourcePrefix } from "../lib/staging/config.js";
import { NetworkStack } from "../lib/staging/network-stack.js";
import { SecretsStack } from "../lib/staging/secrets-stack.js";
import { StorageStack } from "../lib/staging/storage-stack.js";
import { MessagingStack } from "../lib/staging/messaging-stack.js";
import { DatabaseStack } from "../lib/staging/database-stack.js";
import { ClusterStack } from "../lib/staging/cluster-stack.js";
import { EdgeCertStack } from "../lib/staging/edge-cert-stack.js";
import { OpsPlaneStack } from "../lib/staging/ops-plane-stack.js";
import { ObservabilityStack } from "../lib/staging/observability-stack.js";
import { TemporalStack } from "../lib/staging/temporal-stack.js";
import { OpenFgaStack } from "../lib/staging/openfga-stack.js";
import { ComputeStack } from "../lib/staging/compute-stack.js";
import { EdgeDnsStack } from "../lib/staging/edge-dns-stack.js";
import { EdgeCloudFrontWafStack } from "../lib/staging/edge-cloudfront-waf-stack.js";
import { CloudflaredStack } from "../lib/staging/cloudflared-stack.js";
import { MonitoringStack } from "../lib/staging/monitoring-stack.js";
// MsteamsStack import disabled — the Teams integration is not shipped for now
// (pipeline removal only; lib/staging/msteams-stack.ts is retained, just not
// instantiated). Re-enable this import alongside the instantiation block below.
// import { MsteamsStack } from "../lib/staging/msteams-stack.js";
import { AuditArchiveStack } from "../lib/staging/audit-archive-stack.js";
import { AppConfigStack } from "../lib/staging/app-config-stack.js";

const app = new cdk.App({
  context: {
    // Disable the auto-bundled aws-sdk in custom-resource Lambdas. Without
    // this flag, CDK warns on every OpenSearch ESLogGroupPolicy and similar
    // custom-resource synth. We do not use APIs missing from the Lambda
    // runtime SDK, so the latest SDK is unnecessary.
    "@aws-cdk/customresources:installLatestAwsSdkDefault": false,
  },
});

const envName = app.node.tryGetContext("env") as string | undefined;
const baseEnv = loadEnv(envName);

// First-deploy bring-up escape hatch: `-c placeholderImage=true` forces every
// service onto the public nginx placeholder image regardless of the env's
// configured usePlaceholderImage. A brand-new env's ECR repos are empty, so a
// real `cdk deploy` fails with CannotPullContainerError and the compute circuit
// breaker rolls the stack back. Deploy once with this flag to stand up the
// topology, push real images into ECR, then deploy again without it. See
// docs/infra/los-bringup-runbook.md.
const forcePlaceholder =
  app.node.tryGetContext("placeholderImage") === "true" ||
  app.node.tryGetContext("placeholderImage") === true;
const env = forcePlaceholder
  ? { ...baseEnv, usePlaceholderImage: true }
  : baseEnv;
const cdkEnv: cdk.Environment = { account: env.account, region: env.region };
const prefix = resourcePrefix(env);

const network = new NetworkStack(app, `${prefix}-network`, env, {
  env: cdkEnv,
});
const secrets = new SecretsStack(app, `${prefix}-secrets`, env, {
  env: cdkEnv,
});
const storage = new StorageStack(
  app,
  `${prefix}-storage`,
  env,
  secrets.appKey,
  { env: cdkEnv },
);
const messaging = new MessagingStack(
  app,
  `${prefix}-messaging`,
  env,
  secrets.appKey,
  { env: cdkEnv },
);

const database = new DatabaseStack(
  app,
  `${prefix}-database`,
  env,
  network.shared(),
  secrets,
  { env: cdkEnv },
);

const cluster = new ClusterStack(app, `${prefix}-cluster`, env, network.vpc, {
  env: cdkEnv,
});

const edgeCert = new EdgeCertStack(app, `${prefix}-edge-cert`, env, {
  env: cdkEnv,
});

// CloudFront origin lock (Cloudflare-only) lives in us-east-1 (CLOUDFRONT-scope
// WAF). Deploy this, then set CDK_GENESIS_STAGING_CF_WEBACL_ARN to its output
// so EdgeDnsStack's distribution attaches it.
if (env.cloudFront?.enabled) {
  new EdgeCloudFrontWafStack(app, `${prefix}-edge-cf-waf`, env, {
    env: { account: env.account, region: "us-east-1" },
  });
}

new OpsPlaneStack(app, `${prefix}-ops-plane`, env, secrets, { env: cdkEnv });

const observability = new ObservabilityStack(
  app,
  `${prefix}-observability`,
  env,
  network.shared(),
  secrets,
  { env: cdkEnv },
);

const temporal = new TemporalStack(
  app,
  `${prefix}-temporal`,
  env,
  network.shared(),
  cluster.cluster,
  database,
  secrets,
  { env: cdkEnv },
);

// Self-hosted OpenFGA server (Fargate) + dedicated `openfga` DB on the shared
// Aurora + STABLE store/model bootstrap. The gateway's per-request permission
// check + the V2 tuple-sync engine both depend on it. Registered in Cloud Map
// at openfga.axira.internal:8080. The bootstrap custom resource merges the real
// storeId/modelId/canonicalModelId/apiUrl/apiToken into the `openfga` provider
// secret (overwriting the pipeline's placeholder seed). ComputeStack depends on
// this so the gateway reads the real, stable ids and resolves the Cloud Map
// name before it starts.
const openfga = new OpenFgaStack(
  app,
  `${prefix}-openfga`,
  env,
  network.shared(),
  cluster.cluster,
  database,
  secrets,
  { env: cdkEnv },
);

const appConfig = new AppConfigStack(app, `${prefix}-app-config`, env, {
  env: cdkEnv,
});

// User Profile Refresh Lambda: OMITTED from the standalone genesis-prod bundle.
// Its NodejsFunction was the only build-from-source stack (it bundled
// apps/user-profile-refresh-lambda + workspace deps from the monorepo). genesis-prod
// already skipped it (env.name !== "genesis-prod"); the deploy carve-out removes it
// entirely. The cache-eviction event path is unaffected — see GENESIS-PROD-HANDOVER.md.

const compute = new ComputeStack(
  app,
  `${prefix}-compute`,
  env,
  network.shared(),
  cluster.cluster,
  storage,
  secrets,
  database,
  messaging,
  edgeCert.certificate,
  observability,
  appConfig,
  { env: cdkEnv },
);
// Gate compute on the OpenFGA bootstrap: the gateway reads the real
// storeId/modelId/canonicalModelId from the `openfga` secret (written by the
// bootstrap custom resource) and resolves openfga.axira.internal. Without this
// edge, a fresh deploy could start the gateway against the placeholder secret.
compute.addDependency(openfga);
// Gate compute on Temporal too: the agent-runtime + workflow-engine connect to
// the Temporal cluster (TEMPORAL_ADDRESS=temporal.axira.internal:7233) at boot
// and fatally exit without a reachable cluster (circuit-breaker → rollback). The
// two stacks have no implicit CDK edge (TEMPORAL_DNS is a hardcoded Cloud Map
// host string, not a cross-stack token), so a parallel `cdk deploy --all` could
// flip compute onto real images before Temporal is up. Declare the ordering
// explicitly so the real-image flip never precedes a ready Temporal.
compute.addDependency(temporal);

// EdgeDnsStack associates the regional WAF to the ALB and (for non-vpn envs)
// writes Route 53 ALIAS records (apex/api/docs/admin) into the edge-cert hosted
// zone. For vpn private-access (e.g. genesis-prod) the WAF still attaches to the
// internal ALB (prod keeps its WAF as defense-in-depth even over VPN), but the
// A-records are SKIPPED inside the stack: Axira does NOT manage the customer's
// DNS — the customer points their own DNS at the ALB via the `AlbDnsName`
// CfnOutput (ComputeStack).
new EdgeDnsStack(
  app,
  `${prefix}-edge-dns`,
  env,
  edgeCert.hostedZone,
  compute.alb,
  { env: cdkEnv },
);

// Private-access (Cloudflare Tunnel + WARP): the cloudflared connector that
// forwards WARP-routed traffic to the ALB. Only created for "cloudflared" mode;
// the ALB SG (NetworkStack) already restricts ingress to this connector's SG.
// vpn mode has no connector (the customer reaches the internal ALB over their
// own VPN), so this is skipped entirely there.
if (env.privateAccess?.enabled && env.privateAccess.mode !== "vpn") {
  const cloudflared = new CloudflaredStack(
    app,
    `${prefix}-cloudflared`,
    env,
    network.shared(),
    cluster.cluster,
    { env: cdkEnv },
  );
  cloudflared.addDependency(compute);
}

// Microsoft Teams integration — apps/teams-bot ECS service. DISABLED for now:
// the Teams integration is not being shipped, so the MsteamsStack is no longer
// instantiated in ANY env (this previously already skipped the axira-los envs;
// now it is fully disabled). The stack class lib/staging/msteams-stack.ts is
// retained — re-enable by uncommenting this block AND the import above. The
// teams-notify / teams-tombstone SNS+SQS topics in MessagingStack are
// independent of this stack and remain.
//
// Owns the bot.axira.<domain>/api/messages, /v1/notify, /healthz listener rule
// on the shared ALB; defined during T1 of the msteams-integration-build. Not
// deployed until the operator has pushed an image to the ECR repo this stack
// creates and seeded per-customer secrets per
// docs/ai-context/playbooks/msteams-customer-onboarding.md.
// if (!env.name.startsWith("axira-los")) {
//   const msteams = new MsteamsStack(app, `${prefix}-msteams`, env, {
//     env: cdkEnv,
//     cluster: cluster.cluster,
//     alb: compute.alb,
//     httpsListener: compute.httpsListener,
//     shared: network.shared(),
//     secrets,
//   });
//   msteams.addDependency(compute);
// }

const monitoring = new MonitoringStack(
  app,
  `${prefix}-monitoring`,
  env,
  compute,
  database,
  messaging,
  temporal,
  { env: cdkEnv },
);
// MonitoringStack reads temporal.service.serviceName (a cross-stack token) for
// the Temporal RunningTaskCount alarm, so it must deploy after TemporalStack.
monitoring.addDependency(temporal);

// audit-archive subscribes CloudWatch filters to the platform service log
// groups created by ComputeStack. CDK can't infer the dependency from the
// log group *name* (the filters reference it as a string), so declare it
// explicitly. Without this, audit-archive can deploy before compute and
// the subscription filters fail with "log group does not exist".
const auditArchive = new AuditArchiveStack(
  app,
  `${prefix}-audit-archive`,
  env,
  secrets,
  { env: cdkEnv },
);
auditArchive.addDependency(compute);

for (const [k, v] of Object.entries(env.tags)) {
  Tags.of(app).add(k, v);
}

app.synth();
