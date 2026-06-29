#!/usr/bin/env node
/**
 * Dedicated CDK entry for the Genesis DW (Data Warehouse) dev resources.
 *
 * Why a separate entry from bin/axira-infra.ts:
 *  • DW dev resources have no overlap with the main staging/production topology
 *    (network, RDS, Redis, OpenSearch, ECS compute, etc.).
 *  • Keeps the main EnvironmentConfig pristine — no "dev" entry needed there.
 *  • Lets us deploy DW resources without synthesizing the full app graph.
 *
 * Usage:
 *   cd infra
 *   export CDK_DW_ACCOUNT=000000000000
 *   export DEV_ALLOWED_IPS="$(curl -s https://api.ipify.org)/32"
 *
 *   # Synthesize
 *   npx cdk --app "npx tsx bin/axira-dw.ts" synth
 *
 *   # Deploy
 *   npx cdk --app "npx tsx bin/axira-dw.ts" deploy Axira-dev-Redshift
 *
 *   # Tear down (use when done — to stop paying for storage)
 *   npx cdk --app "npx tsx bin/axira-dw.ts" destroy Axira-dev-Redshift
 */
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import {
  RedshiftStack,
  type RedshiftStackConfig,
} from "../lib/redshift-stack.js";

const account = process.env.CDK_DW_ACCOUNT;
if (!account) {
  throw new Error(
    "CDK_DW_ACCOUNT env var is required. Set it to your AWS account id (e.g. 000000000000).",
  );
}

const region = process.env.CDK_DW_REGION ?? "us-east-1";

const allowedIpsRaw = process.env.DEV_ALLOWED_IPS;
if (!allowedIpsRaw) {
  throw new Error(
    "DEV_ALLOWED_IPS env var is required (comma-separated CIDRs, e.g. '203.0.113.42/32'). " +
      "Find your public IP via: curl -s https://api.ipify.org",
  );
}

// Copy orchestrator cadence — every 5 min by default, matches the architecture
// doc §4.5. Set DW_COPY_ORCHESTRATOR_DISABLED=1 to skip provisioning entirely
// (useful during the synchronous-COPY → S3-first migration window where the
// sidecar still owns Redshift loads).
const copyOrchestratorScheduleMin = parseInt(
  process.env.DW_COPY_ORCHESTRATOR_INTERVAL_MIN ?? "5",
  10,
);
const copyOrchestratorSchedule =
  process.env.DW_COPY_ORCHESTRATOR_DISABLED === "1"
    ? undefined
    : events.Schedule.rate(cdk.Duration.minutes(copyOrchestratorScheduleMin));

const config: RedshiftStackConfig = {
  envName: "dev",
  account,
  region,
  baseRpuCapacity: parseInt(process.env.DW_BASE_RPU ?? "8", 10),
  databaseName: process.env.DW_DATABASE_NAME ?? "dev",
  allowedIngressCidrs: allowedIpsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Wildcard — the COPY role can read from any bucket whose name starts
  // with "axira-dwh-archive". We'll provision the bucket in a separate stack
  // later; for now this just pre-authorizes the read path.
  s3ArchiveBucketPattern:
    process.env.DW_S3_ARCHIVE_BUCKET_PATTERN ?? "axira-dwh-archive-*",
  copyOrchestratorSchedule,
  copyOrchestratorLookbackHours: parseInt(
    process.env.DW_COPY_ORCHESTRATOR_LOOKBACK_HOURS ?? "2",
    10,
  ),
};

const app = new cdk.App();

new RedshiftStack(app, `Axira-${config.envName}-Redshift`, config, {
  env: { account: config.account, region: config.region },
  description: "Axira Genesis DW — Redshift Serverless (dev workgroup)",
});

app.synth();
