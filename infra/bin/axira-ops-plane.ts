#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { OpsPlaneStack } from "../lib/ops-plane-stack.js";

// ─── Fleet-ops plane app (Axira-wide singleton) ──────────────────────────
//
// The fleet-ops plane (ops RECEIVER + ops CONSOLE) is a single Axira-wide
// telemetry sink + fleet console. It is NOT per-platform-env: it ingests
// from ALL deployments and presents ONE console to Axira engineers.
//
// It has its OWN two lifecycle environments - the plane's staging and the
// plane's production - which BOTH live in the same Axira AWS account and
// must coexist without collision. These are intentionally decoupled from
// the platform's axira-los-staging / axira-los envs, so the plane configs
// are defined inline here rather than imported from infra/lib/staging.
//
// Each plane env is its own stack:
//   axira-ops-plane-staging - ops-staging / console-staging, VPC 10.80/16
//   axira-ops-plane-prod     - ops / console,                 VPC 10.81/16

const app = new App();

// Account/region for the ops-plane (Axira account, us-west-2). Read the
// ops-specific names first, falling back to the legacy CDK_AXIRA_LOS_* names so
// nothing breaks mid-rename.
const account =
  process.env["CDK_AXIRA_OPS_ACCOUNT"] ??
  process.env["CDK_AXIRA_LOS_ACCOUNT"] ??
  "000000000000";
const region =
  process.env["CDK_AXIRA_OPS_REGION"] ??
  process.env["CDK_AXIRA_LOS_REGION"] ??
  "us-west-2";

// Container image tag pinned into every service task definition. The deploy
// pipeline passes the exact build it tested via `-c imageTag=<sha>` (immutable
// ECR tags); falls back to "latest" for a manual/local synth.
const imageTag =
  (app.node.tryGetContext("imageTag") as string | undefined) ??
  process.env["CDK_AXIRA_OPS_IMAGE_TAG"] ??
  "latest";

interface PlaneEnvConfig {
  readonly stackId: string;
  readonly envName: "staging" | "production";
  readonly opsDomainName: string;
  readonly consoleDomainName: string;
  readonly vpcCidr: string;
  /**
   * Customer gateway egress IPs (their NAT Elastic IPs), as /32 CIDRs, that
   * are the ONLY sources allowed to reach the receiver (`ops.*`). Enforced two
   * ways in the stack: a WAFv2 IPSet allow-rule (the WebACL defaults to BLOCK)
   * and the public ALB security group (ingress :443 only from these CIDRs).
   *
   * REPLACE the placeholder with the real customer NAT EIPs before deploy. Do
   * NOT widen to 0.0.0.0/0 — the receiver is internet-facing-but-IP-locked.
   * The per-customer HMAC ingest token stays on top as defense in depth.
   */
  readonly receiverAllowedCidrs: readonly string[];
  /**
   * ARN of the Secrets Manager secret whose WHOLE value is the cloudflared
   * tunnel token for the CONSOLE connector. The console (`console.*`) is
   * WARP-private — no public ingress — and is reachable ONLY over this tunnel.
   * The secret is created + seeded operationally (never committed); only its
   * ARN lives here. Imported via `fromSecretCompleteArn` so ECS gets a concrete
   * ARN. REPLACE the placeholder with the real secret ARN before deploy.
   */
  readonly consoleTunnelTokenSecretArn: string;
}

const planeEnvs: ReadonlyArray<PlaneEnvConfig> = [
  {
    stackId: "axira-ops-plane-staging",
    envName: "staging",
    opsDomainName: "ops-staging.axiralabs.ai",
    consoleDomainName: "console-staging.axiralabs.ai",
    vpcCidr: "10.80.0.0/16",
    // PLACEHOLDER — replace with the customer's gateway NAT Elastic IPs (/32
    // each). 0.0.0.0/32 matches nothing, so until this is set the receiver is
    // reachable by no one (fail-closed). Overridable via env without a code
    // edit: comma-separated CIDRs in CDK_AXIRA_OPS_STAGING_RECEIVER_CIDRS.
    receiverAllowedCidrs: (
      process.env["CDK_AXIRA_OPS_STAGING_RECEIVER_CIDRS"] || "0.0.0.0/32"
    )
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    // PLACEHOLDER — replace with the real Secrets Manager ARN of the console
    // cloudflared tunnel token (seeded out-of-band). The trailing `-XXXXXX` is
    // Secrets Manager's 6-char random suffix (fromSecretCompleteArn requires
    // it); `REPLAC` is a stand-in until the real secret is created.
    consoleTunnelTokenSecretArn:
      process.env["CDK_AXIRA_OPS_STAGING_CONSOLE_TUNNEL_TOKEN_ARN"] ||
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira-ops/staging/console/cloudflared-token-REPLAC",
  },
  {
    stackId: "axira-ops-plane-prod",
    envName: "production",
    opsDomainName: "ops.axiralabs.ai",
    consoleDomainName: "console.axiralabs.ai",
    vpcCidr: "10.81.0.0/16",
    // PLACEHOLDER — replace with the customer's gateway NAT Elastic IPs (/32
    // each). 0.0.0.0/32 matches nothing (fail-closed). Overridable via env:
    // comma-separated CIDRs in CDK_AXIRA_OPS_PROD_RECEIVER_CIDRS.
    receiverAllowedCidrs: (
      process.env["CDK_AXIRA_OPS_PROD_RECEIVER_CIDRS"] || "0.0.0.0/32"
    )
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    // PLACEHOLDER — replace with the real Secrets Manager ARN of the console
    // cloudflared tunnel token (seeded out-of-band). The trailing `-XXXXXX` is
    // Secrets Manager's 6-char random suffix (fromSecretCompleteArn requires
    // it); `REPLAC` is a stand-in until the real secret is created.
    consoleTunnelTokenSecretArn:
      process.env["CDK_AXIRA_OPS_PROD_CONSOLE_TUNNEL_TOKEN_ARN"] ||
      "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira-ops/production/console/cloudflared-token-REPLAC",
  },
];

for (const cfg of planeEnvs) {
  new OpsPlaneStack(app, cfg.stackId, {
    env: { account, region },
    opsDomainName: cfg.opsDomainName,
    consoleDomainName: cfg.consoleDomainName,
    envName: cfg.envName,
    vpcCidr: cfg.vpcCidr,
    receiverAllowedCidrs: cfg.receiverAllowedCidrs,
    consoleTunnelTokenSecretArn: cfg.consoleTunnelTokenSecretArn,
    imageTag,
    // Optional: import pre-created + Cloudflare-delegated Route53 zones rather
    // than creating them (e.g. CDK_AXIRA_OPS_STAGING_OPS_ZONE_ID=Z…).
    opsHostedZoneId:
      process.env[`CDK_AXIRA_OPS_${cfg.envName.toUpperCase()}_OPS_ZONE_ID`],
    consoleHostedZoneId:
      process.env[`CDK_AXIRA_OPS_${cfg.envName.toUpperCase()}_CONSOLE_ZONE_ID`],
  });
}
