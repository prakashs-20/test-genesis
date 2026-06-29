// Environment matrix and sizing for axira-staging, axira-los-staging, axira-los,
// genesis-staging, genesis-prod, and genesis-prod-staging.

export type EnvName =
  | "axira-staging"
  | "axira-los-staging"
  | "axira-los"
  | "genesis-staging"
  | "genesis-prod"
  | "genesis-prod-staging";

// Shared prod-tier predicate. Prod envs get the larger Fargate sizing, longer
// AppConfig bake windows, and the rest of the prod posture. Add new prod envs
// here so they inherit the same treatment everywhere this is consulted.
export function isProdEnv(envName: EnvName): boolean {
  return envName === "genesis-prod" || envName === "axira-los";
}

export interface EnvConfig {
  readonly name: EnvName;
  readonly account: string;
  readonly region: string;
  readonly domainName: string;
  readonly hostedZoneName: string;
  readonly hostedZoneOwnership: "lookup" | "create";
  /**
   * When true (default for genesis envs), CDK creates an ACM certificate
   * and the ALB serves HTTPS on :443 with HTTP→HTTPS redirect on :80.
   *
   * When false (axira-staging dev), no certificate is issued and the ALB
   * serves plain HTTP on :80. Useful when you can't fix the DNS delegation
   * needed for automatic ACM DNS validation.
   *
   * Production environments should ALWAYS run with httpsEnabled=true.
   */
  readonly httpsEnabled: boolean;
  /**
   * When true, ComputeStack uses a public nginx image as the container for
   * every Fargate service instead of `axira/<env>/<svc>:latest` from ECR.
   * Lets the stack deploy before any application images have been built
   * and pushed. Apps don't work in this mode — the ALB returns 200 from
   * nginx on `/` only — but the infra (ALB, target groups, listeners,
   * Cloud Map, autoscaling) reaches CREATE_COMPLETE. Push real images and
   * `aws ecs update-service --force-new-deployment` to switch over once
   * available.
   *
   * Production environments should ALWAYS run with usePlaceholderImage=false.
   */
  readonly usePlaceholderImage: boolean;
  /**
   * Optional ARN of a pre-existing ACM certificate. When set, EdgeCertStack
   * imports the certificate via Certificate.fromCertificateArn() instead of
   * issuing a new one. This skips ACM DNS validation entirely — useful when
   * you've already issued a wildcard cert for the apex domain and want to
   * avoid the 5–30 minute validation wait on every fresh deploy.
   *
   * The cert MUST cover both `domainName` and `*.domainName`. CDK does not
   * validate this; ALB will fail to attach a mis-scoped cert at runtime.
   */
  readonly acmCertificateArn?: string;
  readonly tags: Record<string, string>;
  readonly vpc: VpcConfig;
  readonly postgres: PostgresConfig;
  readonly redis: RedisConfig;
  readonly opensearch: OpenSearchConfig;
  readonly temporal: TemporalConfig;
  readonly openfga: OpenFgaConfig;
  readonly services: ServiceDef[];
  readonly sqsQueues: SqsQueueDef[];
  readonly snsDomains: readonly string[];
  readonly buckets: BucketDef[];
  readonly providerSecrets: readonly string[];
  /**
   * Which LLM transport the Bedrock-invoking services use for this env.
   *
   *   • "bedrock"   — the platform standard: AWS Bedrock via the AI-SDK
   *     @ai-sdk/amazon-bedrock provider, auth via the task IAM role
   *     (bedrock:InvokeModel), no API key, no external egress. ComputeStack
   *     injects LLM_PROVIDER=bedrock + the model ids + grants the Bedrock IAM.
   *   • "anthropic" — the direct Anthropic API via the AI-SDK @ai-sdk/anthropic
   *     provider, auth via ANTHROPIC_API_KEY (from the axira/<env>/anthropic
   *     secret). Used where Bedrock-Anthropic is unavailable: the
   *     axira-los-staging account is AWS-India (AISPL), which can't use AWS
   *     Marketplace, so Bedrock-Anthropic is blocked. ComputeStack injects
   *     LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY and does NOT grant Bedrock
   *     IAM (not needed).
   */
  readonly llmProvider: "bedrock" | "anthropic";
  readonly bedrock: BedrockConfig;
  readonly slo: SloConfig;
  readonly waf: WafConfig;
  /**
   * Optional CloudFront edge. When enabled, a CloudFront distribution fronts
   * the ALB, terminates TLS, and the ALB is locked so ONLY CloudFront can
   * reach it. Used for genesis-staging (served on an axiralabs.ai host whose
   * DNS lives in Cloudflare). Keep `httpsEnabled=false` when this is on — the
   * ALB stays HTTP-only behind CloudFront.
   */
  readonly cloudFront?: CloudFrontConfig;
  /**
   * Optional private-access edge. When enabled, the site is reachable ONLY
   * over a Cloudflare Tunnel + WARP private network — there is no public
   * ingress at all. A `cloudflared` connector (ECS Fargate, CloudflaredStack)
   * dials out to Cloudflare and forwards WARP-routed traffic to the ALB's
   * private IPs; the ALB SG accepts traffic ONLY from that connector's SG and
   * the ALB serves HTTPS :443 with an imported ACM cert. Off-WARP the hostname
   * resolves (via Cloudflare DNS-only) to the ALB's private IPs, which are
   * unroutable — so the site is invisible rather than auth-walled.
   *
   * Mutually exclusive with `cloudFront` (that is the public-Access model).
   * Used for genesis-staging.
   */
  readonly privateAccess?: PrivateAccessConfig;
  readonly retention: RetentionConfig;
  readonly docs: DocsConfig;
  readonly logsOpenSearch: LogsOpenSearchConfig;
  readonly opsPlane: OpsPlaneConfig;
  /**
   * Customer-side ops-emitter wiring for the workflow-engine. UNSET ⇒ this env
   * does not ship ops events (publisher dark + collector off). Set per-env with
   * that env's receiver endpoint + customer slug + HMAC secret ARN.
   */
  readonly opsEmitter?: OpsEmitterConfig;
  readonly phoenixEndpoint: string;
  readonly featureFlags: FeatureFlagsConfig;
  /**
   * Single-tenant email-domain lock for this deployment (SECURITY-SENSITIVE,
   * OPT-IN). When set (e.g. genesis-prod = "genesiscapital.com"; a
   * comma-separated list is allowed for multi-brand), ComputeStack injects it as
   * the gateway + experience `INSTANCE_EMAIL_DOMAIN` env AND as the experience
   * `NEXT_PUBLIC_INSTANCE_EMAIL_DOMAIN` build-arg, so all four enforcement
   * surfaces agree (the @axira/auth `isEmailAllowedForInstance` gate in the
   * gateway resolve-idp route, the experience /api/auth/* server reject, the BFF,
   * and the client login form). The Auth0-side enforcement (the Instance Domain
   * Lock Action secret) is applied separately by the deploy pipeline's
   * auth0_setup job / scripts/setup-auth0-tenant.mjs from the matching
   * `instance_email_domain` workflow input — keep the two in sync.
   *
   * UNSET (the default) ⇒ the lock stays inert (allows every email domain),
   * which is the correct posture for the shared Axira staging/los envs whose
   * federated testers sign in with assorted Okta profile-email domains.
   */
  readonly instanceEmailDomain?: string;
  /**
   * Optional suffix on the AM audit-archive S3 bucket name
   * (`axira-<name>-am-audit-archive[-<suffix>]-<account>`). Used to sidestep a
   * pre-existing COMPLIANCE-locked (WORM) audit bucket left by a prior teardown
   * that cannot be deleted by anyone until its retention expires — a fresh
   * suffix gives a redeploy a clean bucket. UNSET (default) ⇒ the canonical
   * name (correct for first deploys / Genesis).
   */
  readonly auditArchiveSuffix?: string;
  /**
   * Cross-app navigation origins, injected at RUNTIME on the Next.js apps
   * (experience + admin-hub) as `AXIRA_*_URL` env vars by ComputeStack. The apps
   * read these server-side at request time (runtime-config.server.ts) and
   * surface them to client components — they are NOT baked into the image, so a
   * PROMOTED (re-tagged) image serves each env's OWN URLs (mirrors the
   * AXIRA_GATEWAY_URL pattern).
   *
   * `experienceUrl` and `adminHubUrl` are auto-derived by ComputeStack from
   * `domainName` and `privateAccess.adminAlias` when omitted here, so most envs
   * need not set them. `customerCentralUrl` and `opsConsoleUrl` are OPTIONAL —
   * leave them unset for envs (e.g. axira-los) that do NOT deploy those separate
   * apps; the apps then fall back to the dev localhost default, which is inert
   * for a deployment that never links to them. Set a value only when that app is
   * actually reachable in the env.
   */
  readonly appUrls?: AppUrlsConfig;
}

export interface AppUrlsConfig {
  /** Experience (bank workbench) origin. Defaults to `https://${domainName}`. */
  readonly experienceUrl?: string;
  /** Admin Hub origin. Defaults to the privateAccess.adminAlias host (or
   *  `admin.${domainName}`). */
  readonly adminHubUrl?: string;
  /** Customer Central origin. Unset ⇒ not deployed in this env. */
  readonly customerCentralUrl?: string;
  /** Axira Ops Console origin. Unset ⇒ not linked from this env. */
  readonly opsConsoleUrl?: string;
}

export interface FeatureFlagsConfig {
  readonly cedarAuthzEnabled: boolean;
  readonly amEnforcementEnabled: boolean;
  readonly authorityMatrixEnabled: boolean;
  readonly authorityMatrixStrict: boolean;
  readonly obsDynamicLevelEnabled: boolean;
}

export interface LogsOpenSearchConfig {
  readonly dataNodeInstanceType: string;
  readonly dataNodeCount: number;
  readonly ebsVolumeGiB: number;
}

export interface OpsPlaneConfig {
  readonly opsSubdomain: string;
  readonly consoleSubdomain: string;
}

/**
 * Customer-side ops-emitter config for the workflow-engine — the single egress
 * that ships this env's ops events (service.snapshot, error_group.*, etc.) to
 * the Axira ops-plane receiver. ComputeStack injects these as workflow-engine
 * env vars (see createService → axira-workflow-engine) and grants the wfe task
 * role read on `hmacSecretArn`. ALL values are env-SPECIFIC (the endpoint, the
 * customer slug, the per-customer HMAC secret), so each env that emits sets its
 * own block; UNSET ⇒ the wfe ops publisher/collector stay dark (the emit path
 * drops with `publisher_disabled` and the collector is gated OFF), which is the
 * correct posture for envs not wired into a receiver. Prod/Genesis override by
 * supplying their own block (their own ops-prod endpoint + slug + secret ARN).
 */
export interface OpsEmitterConfig {
  /** Receiver base URL, e.g. https://ops-staging.axiralabs.ai (no trailing slash). */
  readonly endpoint: string;
  /** This customer's slug (the `x-axira-customer` value), e.g. axira-los-staging. */
  readonly customerSlug: string;
  /**
   * Secrets Manager ARN of the per-customer HMAC signing secret. Passed as a
   * PLAIN env var (AXIRA_OPS_HMAC_SECRET_REF) — the wfe resolves it itself via
   * the AWS SDK at boot; it is NOT modeled as an ECS `secrets` entry. The wfe
   * task role is granted secretsmanager:GetSecretValue on exactly this ARN.
   */
  readonly hmacSecretArn: string;
  /** Toggles the wfe error-group emitter (AXIRA_OPS_ERROR_GROUPS_ENABLED). */
  readonly errorGroupsEnabled: boolean;
  /** Toggles the wfe infra-signal-collector (INFRA_SIGNAL_COLLECTOR_ENABLED). */
  readonly infraSignalCollectorEnabled: boolean;
  /**
   * The comma-joined `<slug>=<healthUrl>` list the infra-signal-collector probes
   * (INFRA_COLLECTOR_SERVICE_HEALTH_URLS). Built from the in-cluster Cloud Map
   * DNS + each service's container port + health path.
   */
  readonly serviceHealthUrls: string;
}

export interface DocsConfig {
  readonly subdomain: string;
  readonly containerPort: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  readonly priority: number;
  readonly healthCheckPath: string;
  /** Per-service placeholder override (see ServiceConfig.usePlaceholderImage). */
  readonly usePlaceholderImage?: boolean;
}

export interface VpcConfig {
  readonly cidr: string;
  readonly azCount: number;
  readonly natGateways: number;
}

export interface PostgresConfig {
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  readonly replicaCount: number;
  readonly multiAz: boolean;
  readonly backupRetentionDays: number;
  readonly deletionProtection: boolean;
}

export interface RedisConfig {
  readonly nodeType: string;
  readonly numShards: number;
  readonly replicasPerShard: number;
  readonly multiAz: boolean;
  readonly snapshotRetentionDays: number;
}

export interface OpenSearchConfig {
  readonly dataNodeInstanceType: string;
  readonly dataNodeCount: number;
  readonly masterNodeInstanceType?: string;
  readonly masterNodeCount: number;
  readonly volumeGiB: number;
  readonly multiAz: boolean;
  readonly warmStorage: boolean;
}

export interface TemporalConfig {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly desiredCount: number;
}

/**
 * Self-hosted OpenFGA server (Fargate) sizing. OpenFGA is stateless and
 * scales horizontally — all authorization data lives in the dedicated
 * `openfga` database on the shared Aurora cluster, so Postgres is the
 * shared bottleneck. `minTasks`/`maxTasks` drive CPU-target autoscaling;
 * `maxOpenConns` is the per-replica Postgres connection ceiling
 * (OpenFGA's own default is 30 — keep `maxTasks * maxOpenConns` well
 * under Aurora's max_connections). The runtime check path (the gateway
 * permissions plugin) hits `check()` per write-route request; the V2
 * sync path writes tuples on role/grant changes. See
 * docs/ai-context (scaling math captured in the OpenFGA deploy session).
 */
export interface OpenFgaConfig {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  /** Per-replica OPENFGA_DATASTORE_MAX_OPEN_CONNS (OpenFGA default is 30). */
  readonly maxOpenConns: number;
  /** Per-replica OPENFGA_DATASTORE_MAX_IDLE_CONNS (OpenFGA default is 10). */
  readonly maxIdleConns: number;
}

export type ServiceName =
  | "axira-gateway"
  | "axira-experience"
  | "axira-agent-runtime"
  | "axira-workflow-engine"
  | "axira-admin-hub";

export interface ServiceDef {
  readonly name: ServiceName;
  readonly containerPort: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  readonly publicViaAlb: boolean;
  readonly healthCheckPath: string;
  readonly priority?: number;
  readonly hostHeader?: string;
  // If set, ComputeStack composes the ALB host-header rule as
  // `${subdomain}.${envCfg.domainName}`. Use for services that need to live on
  // their own subdomain (e.g. admin-hub at admin.<domain>) rather than sharing
  // the apex with the experience app.
  readonly subdomain?: string;
  readonly pathPatterns?: readonly string[];
  readonly scaleOnSqsQueue?: string;
  readonly bedrockInvoke: boolean;
  /**
   * Per-service override of the env-wide `usePlaceholderImage`. When set it
   * takes precedence, so a single service can stay on the nginx placeholder
   * (e.g. its image hasn't been published yet) while the rest of the env runs
   * real images.
   */
  readonly usePlaceholderImage?: boolean;
}

export interface SqsQueueDef {
  readonly logicalId: string;
  readonly visibilityTimeoutSeconds: number;
  readonly retentionDays: number;
  readonly priorityLane: boolean;
}

export interface BucketDef {
  readonly logicalId: string;
  readonly versioned: boolean;
  readonly objectLockYears?: number;
  readonly expirationDays?: number;
  readonly transitionToIaDays?: number;
}

export interface BedrockConfig {
  /**
   * Bedrock model ids the task role may invoke. Includes us-west-2
   * cross-region inference-profile ids (us.anthropic.*) for the Claude 4
   * family plus the underlying foundation-model ids the profiles route to. The
   * IAM grant in ComputeStack expands each to its inference-profile ARN plus
   * the underlying per-region foundation-model ARNs.
   */
  readonly allowedModelIds: readonly string[];
  /**
   * Default model id for the conversational router (agent-runtime reads
   * ROUTER_MODEL_ID). Bedrock Haiku 4.5 cross-region inference profile.
   */
  readonly routerModelId: string;
  /**
   * Default model id for document extraction (workflow-engine + agent-runtime
   * read EXTRACTION_MODEL / AXIRA_EXTRACTOR_MODEL). Bedrock Sonnet 4.5 profile.
   */
  readonly extractionModelId: string;
}

export interface SloConfig {
  readonly availabilityTarget: number;
  readonly conversationFirstPaintMs: number;
  readonly conversationEndToEndMs: number;
  readonly dealProgressMs: number;
  readonly fastBurnPctOfBudget: number;
  readonly slowBurnPctOfBudget: number;
  readonly fastBurnWindowMinutes: number;
  readonly slowBurnWindowMinutes: number;
}

export interface WafConfig {
  readonly enableAwsCommon: boolean;
  readonly enableAwsKnownBadInputs: boolean;
  readonly enableAnonymousIpBlock: boolean;
  readonly rateLimitPerIp: number;
}

export interface CloudFrontConfig {
  /** When true, a CloudFront distribution fronts the ALB and the ALB is
   * locked so only CloudFront can reach it (SG ingress restricted to the
   * CloudFront origin-facing prefix list + a WAF rule that 403s any request
   * missing the secret `X-Origin-Verify` header). */
  readonly enabled: boolean;
  /** FQDNs the distribution serves (must be covered by `certArn`). DNS for
   * these is managed externally (Cloudflare) as a CNAME to the dist domain. */
  readonly aliases: readonly string[];
  /** ARN of a **us-east-1** ACM cert covering `aliases` (CloudFront requires
   * us-east-1). Imported, not issued — validated out-of-band (Cloudflare). */
  readonly certArn: string;
  /** Shared secret CloudFront injects as `X-Origin-Verify` and the WAF
   * requires. Sourced from env, never committed (placeholder default). */
  readonly originVerifySecret: string;
  /** Managed prefix list of CloudFront origin-facing IPs for the ALB's region
   * (us-west-2 = pl-82a045eb). The ALB SG allows ingress only from this. */
  readonly originPrefixListId: string;
  /** ARN of a **us-east-1** CLOUDFRONT-scope WAF WebACL that locks the
   * distribution to Cloudflare IPs only (so it can't be hit directly,
   * bypassing Cloudflare Access/WARP). Created by EdgeCloudFrontWafStack;
   * set the ARN here (via env) and the distribution attaches it. Optional —
   * omit to leave the distribution publicly reachable. */
  readonly webAclArn?: string;
}

export interface PrivateAccessConfig {
  /** When true, the env has NO public ingress — it is reachable only over a
   * private path selected by `mode` (default "cloudflared"). */
  readonly enabled: boolean;
  /**
   * Which private-access path fronts the ALB. Default (unset) = "cloudflared".
   *
   *   • "cloudflared" — Axira's own WARP path. A cloudflared connector
   *     (CloudflaredStack) dials OUT to Cloudflare and forwards WARP-routed
   *     traffic to the ALB; the ALB stays internet-facing in scheme but its SG
   *     accepts traffic ONLY from the connector's SG, and Cloudflare DNS-only
   *     records point at the ALB's PRIVATE IPs. Used by axira-los[-staging] and
   *     genesis-staging. Requires `tunnelTokenSecretArn`.
   *
   *   • "vpn" — the CUSTOMER's own VPN path (e.g. genesis-prod). There is NO
   *     cloudflared connector and NO Cloudflare involvement at all. The ALB is
   *     created INTERNAL (private subnets, private IPs only) and its SG admits
   *     ingress from the customer's `vpnCidrs`. Axira does NOT manage the
   *     customer's DNS: no Route 53 records are written (EdgeDnsStack is
   *     skipped) — the ALB DNS name is emitted as the `AlbDnsName` CfnOutput
   *     (ComputeStack) for the customer to point THEIR own DNS at. The ALB :443
   *     cert is still imported from `albCertArn` (validated in the customer's
   *     own DNS, out of band). `tunnelTokenSecretArn` is unused in this mode.
   */
  readonly mode?: "cloudflared" | "vpn";
  /** FQDNs served privately (for reference/docs). For "cloudflared" mode, DNS
   * for these is managed in Cloudflare as DNS-only (grey) A records pointing at
   * the ALB's PRIVATE IPs. For "vpn" mode, the CUSTOMER points their own DNS at
   * the ALB (see the `AlbDnsName` CfnOutput). */
  readonly aliases: readonly string[];
  /** Customer VPN/VPC CIDR(s) allowed ingress to the ALB on :80/:443. Used ONLY
   * by "vpn" mode (in place of the cloudflared connector SG). In "cloudflared"
   * mode the ALB SG admits only the connector SG and this is ignored. Supply the
   * exact CIDR(s) the customer's VPN clients / peered network reach the VPC
   * from; never `0.0.0.0/0` (that would defeat the private posture). */
  readonly vpnCidrs?: readonly string[];
  /** ARN of an ACM cert (in `region`, NOT us-east-1) covering `aliases`. The
   * ALB :443 listener serves it, so the browser — which connects straight to
   * the ALB over the tunnel/VPN — gets a trusted cert. Imported, not issued
   * (validated out-of-band via the DNS owner). ARNs are not secrets. */
  readonly albCertArn: string;
  /** ARN of the Secrets Manager secret holding the cloudflared tunnel token
   * (the whole secret value is the token). Created + seeded operationally,
   * never committed; only its ARN lives here. The connector reads it as
   * `TUNNEL_TOKEN`. REQUIRED for "cloudflared" mode; UNUSED for "vpn" mode. */
  readonly tunnelTokenSecretArn?: string;
  /** Connector task sizing (defaults: 256 CPU / 512 MiB / 1 task). */
  readonly connectorCpu?: number;
  readonly connectorMemoryMiB?: number;
  readonly desiredCount?: number;
  /** Host the admin-hub app is served at over the tunnel (e.g.
   * `admin.genesis-staging.axiralabs.ai`). When set, ComputeStack uses it for
   * the admin-hub ALB host-header rule AND its `AUTH0_BASE_URL` (the Auth0 SDK
   * Universal-Login callback origin), instead of `admin.${domainName}` (which
   * is the undelegated genesis-capital.com host). The Auth0 app's Allowed
   * Callback/Logout URLs for this host are configured operationally (external
   * SaaS — see the playbook), not in CDK. */
  readonly adminAlias?: string;
  /** Extra ACM cert ARNs (same region) added to the ALB :443 listener as SNI
   * certs beyond `albCertArn`. Use a wildcard `*.<apex>` here so subdomain
   * hosts like `adminAlias` present a browser-trusted cert. */
  readonly additionalCertArns?: readonly string[];
}

export interface RetentionConfig {
  readonly logRetentionDays: number;
  readonly albLogExpirationDays: number;
  readonly auditExportExpirationDays: number;
}

const SNS_DOMAINS_PLATFORM = [
  "platform",
  "knowledge",
  "evidence",
  "agent",
  "documents",
  "human-loop",
  "orchestration",
  "rules",
  "prompts",
  "events",
  "knowledge-platform",
  "dimensions",
] as const;

const SNS_DOMAINS_LENDING = [
  "deal",
  "loan",
  "covenant",
  "draw",
  "underwriting",
  "closing",
] as const;

const SNS_DOMAINS_COMPLIANCE = [
  "case",
  "subject",
  "finding",
  "screening",
  "sar",
  "monitoring",
] as const;

export const ALL_SNS_DOMAINS = [
  ...SNS_DOMAINS_PLATFORM,
  ...SNS_DOMAINS_LENDING,
  ...SNS_DOMAINS_COMPLIANCE,
] as const;

export const STANDARD_SQS_QUEUES: SqsQueueDef[] = [
  {
    logicalId: "projection-consumer",
    visibilityTimeoutSeconds: 60,
    retentionDays: 4,
    priorityLane: true,
  },
  {
    logicalId: "search-indexer",
    visibilityTimeoutSeconds: 30,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "notification-dispatcher",
    visibilityTimeoutSeconds: 30,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "compliance-monitor",
    visibilityTimeoutSeconds: 60,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "agui-streamer",
    visibilityTimeoutSeconds: 30,
    retentionDays: 1,
    priorityLane: false,
  },
  {
    logicalId: "workflow-trigger",
    visibilityTimeoutSeconds: 60,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "webhook-dispatcher",
    visibilityTimeoutSeconds: 30,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "governance-events",
    visibilityTimeoutSeconds: 60,
    retentionDays: 4,
    priorityLane: false,
  },
  {
    logicalId: "reconciliation-starter",
    visibilityTimeoutSeconds: 60,
    retentionDays: 4,
    priorityLane: false,
  },
];

export const BUCKETS_PLATFORM: BucketDef[] = [
  { logicalId: "documents", versioned: true, expirationDays: 365 },
  { logicalId: "evidence", versioned: true, objectLockYears: 7 },
  { logicalId: "exports", versioned: false, expirationDays: 90 },
  { logicalId: "assets", versioned: true, expirationDays: 180 },
  { logicalId: "alb-logs", versioned: false, expirationDays: 90 },
  {
    logicalId: "audit-exports",
    versioned: true,
    transitionToIaDays: 30,
    expirationDays: 2555,
  },
];

export const PROVIDER_SECRETS = [
  "auth0",
  "auth0-m2m",
  // Auth0 Management API M2M app for the gateway's login-federation
  // /v1/admin/identity/login-federation/auth0-connections endpoint (lists +
  // creates Auth0 enterprise connections for SSO bring-up). DISTINCT app from
  // auth0-m2m (org/user provisioning): this one must be authorized for the
  // Auth0 Management API with scopes read:connections + create:connections.
  // Keys: clientId, clientSecret (domain reuses the `auth0` secret's `domain`).
  // Created empty; an operator seeds the JSON out-of-band.
  "auth0-mgmt",
  // Anthropic API key for the direct-Anthropic LLM provider (the AI-SDK
  // @ai-sdk/anthropic path). Used by envs whose `llmProvider` is "anthropic"
  // — e.g. axira-los-staging, whose AWS-India (AISPL) account can't use AWS
  // Marketplace and so cannot invoke Bedrock-Anthropic. Key: apiKey. Created
  // empty for every env; only the anthropic-provider envs are seeded out-of-band
  // (the seed loop in .github/workflows/_deploy-los.yml). Bedrock-provider envs
  // leave it empty and never read it (compute-stack injects ANTHROPIC_API_KEY
  // only when env.llmProvider === "anthropic").
  "anthropic",
  "openfga",
  "salesforce",
  "docusign",
  "msgraph",
  "gmail",
  "drive",
  "glass",
  "gdi",
  "jfrog",
] as const;

function services(envName: EnvName): ServiceDef[] {
  const isProd = isProdEnv(envName);

  return [
    {
      name: "axira-gateway",
      containerPort: 3001,
      cpu: isProd ? 2048 : 1024,
      memoryMiB: isProd ? 4096 : 2048,
      minTasks: isProd ? 3 : 2,
      maxTasks: isProd ? 9 : 4,
      publicViaAlb: true,
      healthCheckPath: "/health",
      priority: 10,
      // NOTE: do NOT include "/api/*" here. The experience app owns the entire
      // /api/* namespace on the shared apex host (Next.js routes: /api/auth/*,
      // the /api/gateway/* BFF, /api/health, …). A greedy "/api/*" on this
      // higher-priority gateway rule hijacks the browser's login POST
      // (/api/auth/password-login) to the gateway, which has no such route and
      // no bearer token → 401 "Missing authorization" and login fails. The
      // gateway is reached browser-side through the experience BFF
      // (/api/gateway/* → internal gateway /v1/*), and directly only on /v1/*.
      pathPatterns: ["/v1/*", "/health"],
      // The gateway invokes Bedrock in-process for the Okta group→role mapping
      // suggester (apps/gateway identity/mapping-suggester.ts, via the AI-SDK
      // @ai-sdk/amazon-bedrock client). It needs the bedrock:InvokeModel grant
      // + the model-id + LLM_PROVIDER=bedrock env (injected in compute-stack
      // when bedrockInvoke is true). Without this the suggester silently fell
      // back to the mock provider and returned no usable suggestions.
      bedrockInvoke: true,
    },
    {
      name: "axira-experience",
      containerPort: 3000,
      cpu: isProd ? 1024 : 512,
      memoryMiB: isProd ? 2048 : 1024,
      minTasks: isProd ? 2 : 2,
      maxTasks: isProd ? 6 : 4,
      publicViaAlb: true,
      healthCheckPath: "/api/health",
      priority: 30,
      pathPatterns: ["/*"],
      bedrockInvoke: false,
    },
    {
      name: "axira-agent-runtime",
      containerPort: 3002,
      cpu: isProd ? 2048 : 1024,
      memoryMiB: isProd ? 8192 : 2048,
      minTasks: isProd ? 2 : 1,
      maxTasks: isProd ? 8 : 3,
      publicViaAlb: false,
      healthCheckPath: "/health/ready",
      bedrockInvoke: true,
    },
    {
      name: "axira-workflow-engine",
      containerPort: 3003,
      cpu: isProd ? 2048 : 1024,
      memoryMiB: isProd ? 4096 : 2048,
      minTasks: isProd ? 2 : 1,
      maxTasks: isProd ? 8 : 3,
      publicViaAlb: false,
      healthCheckPath: "/health",
      scaleOnSqsQueue: "projection-consumer",
      bedrockInvoke: true,
    },
    {
      // V3 Admin Hub — separate Next.js app deployed per customer at admin.<domain>.
      // Host-header isolation keeps it independent of the bank workbench at the
      // apex domain; ALB rule priority is below gateway and above experience.
      name: "axira-admin-hub",
      containerPort: 3010,
      cpu: isProd ? 1024 : 512,
      memoryMiB: isProd ? 2048 : 1024,
      minTasks: isProd ? 1 : 1,
      maxTasks: isProd ? 3 : 2,
      publicViaAlb: true,
      healthCheckPath: "/api/health",
      priority: 20,
      subdomain: "admin",
      pathPatterns: ["/*"],
      bedrockInvoke: false,
    },
  ];
}

const baseSlo: SloConfig = {
  availabilityTarget: 0.9995,
  conversationFirstPaintMs: 3000,
  conversationEndToEndMs: 15000,
  dealProgressMs: 300,
  fastBurnPctOfBudget: 2,
  slowBurnPctOfBudget: 5,
  fastBurnWindowMinutes: 60,
  slowBurnWindowMinutes: 360,
};

const baseRetention: RetentionConfig = {
  logRetentionDays: 30,
  albLogExpirationDays: 90,
  auditExportExpirationDays: 2555,
};

function docsConfig(envName: EnvName): DocsConfig {
  const isProd = isProdEnv(envName);
  return {
    subdomain: "docs",
    containerPort: 8080,
    cpu: 256,
    memoryMiB: 512,
    minTasks: isProd ? 2 : 1,
    maxTasks: isProd ? 4 : 2,
    priority: 50,
    healthCheckPath: "/healthz",
    // The docs image ships from a separate Axira docs repo and is not published
    // to JFrog/ECR by this monorepo's pipeline, so the docs ECR repo is empty in
    // every env. Pin docs to the nginx placeholder until that image pipeline
    // exists — otherwise flipping an env to real images would point the docs
    // task definition at a non-existent image. Remove once docs is published.
    usePlaceholderImage: true,
  };
}

// OpenFGA Fargate sizing per env. Staging gets a single small replica
// (low QPS, the role-fallback in the gateway tolerates a brief gap on
// deploy); prod runs ≥2 replicas across AZs for the per-request check
// path and autoscales on CPU. maxOpenConns is kept BELOW OpenFGA's
// default of 30 so the worst-case fan-out (maxTasks × maxOpenConns +
// the gateway/runtime/engine pools + temporal) stays comfortably under
// the Aurora writer's max_connections at the configured ACU ceiling.
function openfgaConfig(envName: EnvName): OpenFgaConfig {
  const isProd = isProdEnv(envName);
  return {
    cpu: isProd ? 1024 : 512,
    memoryMiB: isProd ? 2048 : 1024,
    minTasks: isProd ? 2 : 1,
    maxTasks: isProd ? 6 : 2,
    // Prod: 6 replicas × 20 = 120 max FGA conns. Staging: 2 × 15 = 30.
    maxOpenConns: isProd ? 20 : 15,
    maxIdleConns: isProd ? 5 : 5,
  };
}

// Bedrock model ids the platform invokes (agent-runtime + workflow-engine).
//  • Every model is Claude 4 family, invoked via us.anthropic.* us-west-2
//    cross-region inference profiles. The Claude 4 family REQUIRES a profile —
//    bare foundation-model ids are no longer directly invokable — so the SDK
//    always calls a `us.` profile id, never a foundation model directly.
//  • Router (conversational intent) = Haiku 4.5; extraction = Sonnet 4.5.
//  • The bare anthropic.* foundation-model ids are retained so the IAM grant
//    can authorize the underlying models the profiles route to.
const ROUTER_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const EXTRACTION_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const bedrockModels: readonly string[] = [
  // Invokable inference-profile ids (the strings passed to bedrock(modelId)).
  EXTRACTION_MODEL_ID,
  ROUTER_MODEL_ID,
  // Underlying foundation-model ids the inference profiles route to (for IAM).
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
];

const ENVS: Record<EnvName, EnvConfig> = {
  "axira-staging": {
    name: "axira-staging",
    account: process.env["CDK_AXIRA_STAGING_ACCOUNT"] ?? "000000000000",
    region: process.env["CDK_AXIRA_STAGING_REGION"] ?? "us-west-2",
    domainName: "staging.axiralabs.ai",
    // Subdomain-delegated zone. axiralabs.ai itself stays at Cloudflare; CDK
    // owns staging.axiralabs.ai as its own Route 53 zone. After the first
    // edge-cert deploy, paste the four NS values from the `DelegationNsRecords`
    // CFN output into Cloudflare as NS records for "staging" so ACM DNS
    // validation can complete.
    hostedZoneName: "staging.axiralabs.ai",
    hostedZoneOwnership: "create",
    // ALB serves HTTP-only in dev because we can't complete ACM DNS
    // validation without Cloudflare delegation. Flip this back to `true`
    // once the staging.axiralabs.ai NS records point to Route 53.
    httpsEnabled: false,
    // Use a public nginx image until real app images are built+pushed to
    // ECR. Lets ComputeStack reach CREATE_COMPLETE so we can validate
    // the rest of the staging topology before app code lands. Flip back
    // to `false` once you push real images and run
    // `aws ecs update-service --force-new-deployment`.
    usePlaceholderImage: true,
    tags: {
      Project: "Axira",
      Environment: "staging",
      Owner: "axira-platform",
      ManagedBy: "cdk",
      CostCenter: "axira-staging",
    },
    vpc: { cidr: "10.20.0.0/16", azCount: 2, natGateways: 1 },
    postgres: {
      auroraMinAcu: 0.5,
      auroraMaxAcu: 1,
      replicaCount: 0,
      multiAz: false,
      backupRetentionDays: 7,
      deletionProtection: false,
    },
    redis: {
      nodeType: "cache.t4g.medium",
      numShards: 1,
      replicasPerShard: 0,
      multiAz: false,
      snapshotRetentionDays: 3,
    },
    opensearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      masterNodeCount: 0,
      volumeGiB: 50,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
    openfga: openfgaConfig("axira-staging"),
    services: services("axira-staging"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // axira-staging — Bedrock standard
    llmProvider: "bedrock",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: baseSlo,
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: false,
      rateLimitPerIp: 2000,
    },
    retention: baseRetention,
    docs: docsConfig("axira-staging"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      ebsVolumeGiB: 50,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },

  "genesis-staging": {
    name: "genesis-staging",
    account: process.env["CDK_GENESIS_STAGING_ACCOUNT"] ?? "000000000000",
    region: process.env["CDK_GENESIS_STAGING_REGION"] ?? "us-west-2",
    domainName: "staging.axira.genesis-capital.com",
    hostedZoneName: "staging.axira.genesis-capital.com",
    hostedZoneOwnership: "create",
    // genesis-staging is served PRIVATELY over a Cloudflare Tunnel + WARP
    // private network (see `privateAccess` below) — no public ingress. The ALB
    // terminates TLS on :443 with a us-west-2 ACM cert for the axiralabs.ai
    // host; a cloudflared connector (CloudflaredStack) forwards WARP-routed
    // traffic to the ALB's private IPs, and the ALB SG accepts traffic ONLY
    // from that connector. httpsEnabled stays false because we do NOT use the
    // genesis-capital.com EdgeCertStack path (GoDaddy never delegated
    // `staging.axira`, so ACM DNS validation there can't complete) — the cert
    // is supplied via privateAccess.albCertArn instead.
    //
    // (Superseded the earlier public CloudFront + Cloudflare Access model. The
    // CloudFront edge stacks remain in the repo, gated on `cloudFront`, for
    // other envs; genesis-staging just no longer sets it.)
    httpsEnabled: false,
    privateAccess: {
      enabled: true,
      aliases: ["genesis-staging.axiralabs.ai"],
      // us-west-2 ACM cert (NOT us-east-1 — that's CloudFront-only). Trusted by
      // browsers, so the one-time self-signed warning is gone.
      albCertArn:
        process.env["CDK_GENESIS_STAGING_ALB_CERT_ARN"] ??
        "arn:aws:acm:us-west-2:000000000000:certificate/00896fa8-7e63-4ec1-81b6-481d4fc30343",
      // Secrets Manager ARN of the cloudflared tunnel token (value seeded
      // operationally, never committed — only the ARN lives here).
      tunnelTokenSecretArn:
        process.env["CDK_GENESIS_STAGING_CLOUDFLARED_TOKEN_ARN"] ??
        "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira/genesis-staging/cloudflared-token-CQDZkc",
      // admin-hub served at its own axiralabs host over the tunnel (the app's
      // `admin.${domainName}` host is the undelegated genesis-capital one).
      // Drives the admin-hub ALB rule host + AUTH0_BASE_URL. The Auth0 app's
      // Allowed Callback/Logout URLs for this host are set operationally.
      adminAlias: "admin.genesis-staging.axiralabs.ai",
      // Wildcard cert covering admin.genesis-staging.axiralabs.ai (and future
      // subdomains), added to the ALB :443 listener as an SNI cert alongside
      // the apex `albCertArn`. Validated out-of-band (same Cloudflare CNAME).
      additionalCertArns: [
        process.env["CDK_GENESIS_STAGING_WILDCARD_CERT_ARN"] ??
          "arn:aws:acm:us-west-2:000000000000:certificate/02509162-9dbf-41cf-966f-edaa9fbdb9c6",
      ],
    },
    // Real images: v1.0.0 has been published to JFrog and mirrored to
    // `axira/genesis-staging/<svc>:latest` for the 5 core services, so they run
    // their real images. Services whose image isn't published yet stay on the
    // nginx placeholder via the per-service `usePlaceholderImage` override
    // (docs — separate repo; teams-bot runs via the msteams stack's own flag).
    usePlaceholderImage: false,
    tags: {
      Project: "Axira",
      Environment: "staging",
      Owner: "axira-genesis-capital",
      ManagedBy: "cdk",
      CostCenter: "axira-genesis-staging",
    },
    vpc: { cidr: "10.30.0.0/16", azCount: 2, natGateways: 1 },
    postgres: {
      auroraMinAcu: 0.5,
      auroraMaxAcu: 1,
      replicaCount: 0,
      multiAz: false,
      backupRetentionDays: 14,
      deletionProtection: false,
    },
    redis: {
      nodeType: "cache.t4g.medium",
      numShards: 1,
      replicasPerShard: 0,
      multiAz: false,
      snapshotRetentionDays: 7,
    },
    opensearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      masterNodeCount: 0,
      volumeGiB: 50,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
    openfga: openfgaConfig("genesis-staging"),
    services: services("genesis-staging"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // genesis-staging — Bedrock standard
    llmProvider: "bedrock",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: baseSlo,
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: false,
      rateLimitPerIp: 2000,
    },
    retention: baseRetention,
    docs: docsConfig("genesis-staging"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      ebsVolumeGiB: 50,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },

  // GENESIS PRODUCTION — deployed into GENESIS'S OWN AWS account (not Axira's),
  // reached over GENESIS'S OWN VPN (NOT cloudflared/WARP — that path is
  // Axira-only), with DNS in GENESIS'S OWN Route 53 for their own domain
  // (genesiscapital.com). Account/region come from CDK_GENESIS_PROD_* env vars
  // at deploy time (parameterized, never hardcoded — mirrors CDK_AXIRA_LOS_*).
  // Differences vs axira-los: privateAccess.mode="vpn" (internal ALB, VPN-CIDR
  // SG ingress, no cloudflared stack, no Axira-written DNS — the ALB DNS name is
  // emitted as the AlbDnsName CfnOutput for Genesis to point their Route 53 at);
  // imported ACM cert from CDK_GENESIS_PROD_ALB_CERT_ARN (Genesis issues +
  // validates it in their Route 53); NO auditArchiveSuffix (fresh account, no
  // pre-existing WORM bucket to dodge).
  "genesis-prod": {
    name: "genesis-prod",
    account: process.env["CDK_GENESIS_PROD_ACCOUNT"] ?? "000000000000",
    region: process.env["CDK_GENESIS_PROD_REGION"] ?? "us-west-2",
    // Genesis-owned host. The platform is served at axira-los.genesiscapital.com
    // (admin at admin.axira-los.genesiscapital.com), per GENESIS-PRE-SHIP-
    // CHECKLIST.md. Genesis owns genesiscapital.com + its Route 53; Axira does
    // not. hostedZoneOwnership stays "create" so EdgeCertStack provisions an
    // (empty, harmless) public subzone for THIS host in Genesis's account —
    // EdgeDnsStack writes NO records into it for vpn mode (Axira manages no
    // Genesis DNS), and httpsEnabled=false so EdgeCertStack issues no ACM cert
    // (the ALB cert is imported via privateAccess.albCertArn instead). "lookup"
    // is NOT used: a fresh account has no pre-existing zone, which would fail the
    // cross-account zone lookup at synth.
    domainName: "axira-los.genesiscapital.com",
    hostedZoneName: "axira-los.genesiscapital.com",
    hostedZoneOwnership: "create",
    // HTTP-only EdgeCertStack path disabled: the ALB cert is supplied via
    // privateAccess.albCertArn (a Genesis-issued, Genesis-validated ACM cert),
    // exactly as the other private-access envs do. The ALB still serves HTTPS
    // :443 (ComputeStack imports albCertArn regardless of httpsEnabled).
    httpsEnabled: false,
    usePlaceholderImage: false,
    // Genesis reaches the platform over THEIR OWN VPN (mode="vpn"): the ALB is
    // INTERNAL (private IPs only), its SG admits only Genesis's VPN/VPC CIDR(s)
    // (CDK_GENESIS_PROD_VPN_CIDRS), there is NO cloudflared connector + NO
    // Cloudflare, and Axira writes NO DNS — Genesis points their own Route 53 at
    // the ALB via the AlbDnsName CfnOutput. The :443 cert is imported from a
    // Genesis-provided ACM ARN (validated in Genesis's Route 53, out of band).
    privateAccess: {
      enabled: true,
      mode: "vpn",
      aliases: ["axira-los.genesiscapital.com"],
      // Genesis's VPN/VPC CIDR(s) allowed to the internal ALB. REQUIRED —
      // synth/deploy fails if empty (the ALB would admit nothing). Genesis
      // supplies these via the CDK_GENESIS_PROD_VPN_CIDRS env var
      // (comma-separated). The fallback is this env's own VPC CIDR (VPC-internal
      // reach only, never public) — a safe placeholder that Genesis MUST
      // override with their real VPN/peered CIDR before the first deploy; it is
      // intentionally NOT 0.0.0.0/0.
      vpnCidrs: (process.env["CDK_GENESIS_PROD_VPN_CIDRS"] ?? "10.40.0.0/16")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      // Genesis-issued ACM cert (us-west-2, NOT us-east-1) covering the apex +
      // *.apex, validated in Genesis's Route 53. Genesis supplies the ARN.
      albCertArn:
        process.env["CDK_GENESIS_PROD_ALB_CERT_ARN"] ??
        "arn:aws:acm:us-west-2:000000000000:certificate/REPLACE-WITH-GENESIS-CERT-ARN",
      adminAlias: "admin.axira-los.genesiscapital.com",
      // Optional extra SNI cert for the admin host if Genesis issues a separate
      // (non-wildcard) cert. If their albCertArn already covers apex + *.apex,
      // leave CDK_GENESIS_PROD_WILDCARD_CERT_ARN unset — the apex wildcard then
      // serves admin.* via SNI and no extra cert is added.
      additionalCertArns: process.env["CDK_GENESIS_PROD_WILDCARD_CERT_ARN"]
        ? [process.env["CDK_GENESIS_PROD_WILDCARD_CERT_ARN"]]
        : [],
    },
    // Cross-app runtime origins (injected as AXIRA_*_URL on the Next apps). This
    // env deploys ONLY two apps — experience (apex) + admin-hub (admin.<apex>) —
    // mirroring axira-los; customer-central + ops-console are separate apps not
    // in this deploy and are intentionally left unset.
    appUrls: {
      experienceUrl: "https://axira-los.genesiscapital.com",
      adminHubUrl: "https://admin.axira-los.genesiscapital.com",
    },
    // Single-customer prod: lock sign-in to the Genesis corporate email domain
    // across every connection. Injected into the gateway + experience
    // INSTANCE_EMAIL_DOMAIN env + the experience NEXT_PUBLIC build-arg
    // (compute-stack), and applied Auth0-side by the deploy pipeline's
    // auth0_setup job from the matching `instance_email_domain` input. NOTE
    // (human decision): confirm the exact Genesis corporate email domain before
    // the first prod login — "genesiscapital.com" is the assumed value; if their
    // users sign in under a different domain, update this AND the genesis-prod
    // deploy caller's input.
    instanceEmailDomain: "genesiscapital.com",
    tags: {
      Project: "Axira",
      Environment: "production",
      Owner: "axira-genesis-capital",
      ManagedBy: "cdk",
      CostCenter: "axira-genesis-prod",
    },
    vpc: { cidr: "10.40.0.0/16", azCount: 3, natGateways: 3 },
    postgres: {
      auroraMinAcu: 1,
      auroraMaxAcu: 8,
      replicaCount: 1,
      multiAz: true,
      backupRetentionDays: 35,
      deletionProtection: true,
    },
    redis: {
      nodeType: "cache.r7g.large",
      numShards: 1,
      replicasPerShard: 1,
      multiAz: true,
      snapshotRetentionDays: 14,
    },
    opensearch: {
      dataNodeInstanceType: "t3.medium.search",
      dataNodeCount: 3,
      masterNodeCount: 0,
      volumeGiB: 100,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 2048, memoryMiB: 4096, desiredCount: 3 },
    openfga: openfgaConfig("genesis-prod"),
    services: services("genesis-prod"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // genesis-prod — Bedrock standard
    llmProvider: "bedrock",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: { ...baseSlo, availabilityTarget: 0.9995 },
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: true,
      rateLimitPerIp: 6000,
    },
    retention: { ...baseRetention, logRetentionDays: 90 },
    docs: docsConfig("genesis-prod"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.medium.search",
      dataNodeCount: 3,
      ebsVolumeGiB: 100,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },

  // GENESIS PROD-SHAPED STAGING — Genesis's OWN staging env, deployed into
  // GENESIS'S SINGLE AWS account (the SAME account as genesis-prod) and run by
  // Genesis themselves from the SAME standalone ZIP as prod (the no-monorepo
  // _deploy-genesis-standalone.yml path). It mirrors genesis-prod's SHAPE — VPN
  // private-access (internal ALB, VPN-CIDR SG ingress, NO cloudflared/Cloudflare,
  // no Axira-written DNS), the genesiscapital.com domain
  // (axira-los-staging.genesiscapital.com + admin.*), instanceEmailDomain locked
  // to genesiscapital.com, llmProvider="bedrock", and an imported ACM cert
  // (httpsEnabled=false + albCertArn from env) — but uses STAGING-TIER resources
  // (small Aurora/Redis/OpenSearch, single-AZ, staging service shape), so it is
  // DELIBERATELY NOT added to isProdEnv(): services()/openfgaConfig()/docsConfig()
  // all branch on isProdEnv and therefore size this env at the staging tier.
  //
  // It coexists with genesis-prod in the one Genesis account: every resource is
  // env-prefixed (axira-genesis-prod-staging-*) so there is no name collision, and
  // VPC CIDR 10.41/16 does not overlap genesis-prod's 10.40/16.
  //
  // Account/region/cert/VPN-CIDRs come from NEW env vars at deploy time, each
  // falling back to the genesis-prod var so the SAME single Genesis account drives
  // both envs when only the prod vars are set:
  //   • CDK_GENESIS_PROD_STAGING_ACCOUNT  ?? CDK_GENESIS_PROD_ACCOUNT
  //   • CDK_GENESIS_PROD_STAGING_REGION   ?? CDK_GENESIS_PROD_REGION
  //   • CDK_GENESIS_PROD_STAGING_VPN_CIDRS (own fallback to this env's VPC CIDR)
  //   • CDK_GENESIS_PROD_STAGING_ALB_CERT_ARN
  //
  // Auth0: the staging env signs in against Axira's Dev/Staging Auth0 tenant
  // (axiralabs.us.auth0.com) — but that is NOT a code field here. It is read from
  // the seeded `auth0` secret's `.domain` at deploy time, and the staging deploy
  // simply seeds a staging seed secret (GENESIS_STAGING_SECRETS_JSON) whose
  // .auth0.domain points at the Dev tenant. Nothing is hardcoded.
  "genesis-prod-staging": {
    name: "genesis-prod-staging",
    account:
      process.env["CDK_GENESIS_PROD_STAGING_ACCOUNT"] ??
      process.env["CDK_GENESIS_PROD_ACCOUNT"] ??
      "000000000000",
    region:
      process.env["CDK_GENESIS_PROD_STAGING_REGION"] ??
      process.env["CDK_GENESIS_PROD_REGION"] ??
      "us-west-2",
    // Genesis-owned host (staging). Served at axira-los-staging.genesiscapital.com
    // (admin at admin.axira-los-staging.genesiscapital.com). Genesis owns
    // genesiscapital.com + its Route 53; Axira does not. hostedZoneOwnership stays
    // "create" so EdgeCertStack provisions an (empty, harmless) public subzone for
    // THIS host — EdgeDnsStack writes NO records into it for vpn mode, and
    // httpsEnabled=false so EdgeCertStack issues no ACM cert (the ALB cert is
    // imported via privateAccess.albCertArn instead). Same posture as genesis-prod.
    domainName: "axira-los-staging.genesiscapital.com",
    hostedZoneName: "axira-los-staging.genesiscapital.com",
    hostedZoneOwnership: "create",
    // HTTP-only EdgeCertStack path disabled: the ALB cert is supplied via
    // privateAccess.albCertArn (a Genesis-issued, Genesis-validated ACM cert). The
    // ALB still serves HTTPS :443 (ComputeStack imports albCertArn regardless of
    // httpsEnabled), exactly like genesis-prod.
    httpsEnabled: false,
    usePlaceholderImage: false,
    // Genesis reaches staging over THEIR OWN VPN (mode="vpn"): the ALB is INTERNAL
    // (private IPs only), its SG admits only Genesis's VPN/VPC CIDR(s)
    // (CDK_GENESIS_PROD_STAGING_VPN_CIDRS), there is NO cloudflared connector + NO
    // Cloudflare, and Axira writes NO DNS — Genesis points their own Route 53 at the
    // ALB via the AlbDnsName CfnOutput. The :443 cert is imported from a
    // Genesis-provided ACM ARN (validated in Genesis's Route 53, out of band).
    privateAccess: {
      enabled: true,
      mode: "vpn",
      aliases: ["axira-los-staging.genesiscapital.com"],
      // Genesis's VPN/VPC CIDR(s) allowed to the internal ALB. REQUIRED —
      // synth/deploy fails if empty (the ALB would admit nothing). Genesis supplies
      // these via CDK_GENESIS_PROD_STAGING_VPN_CIDRS (comma-separated). The fallback
      // is this env's own VPC CIDR (VPC-internal reach only, never public) — a safe
      // placeholder Genesis MUST override with their real VPN/peered CIDR before the
      // first deploy; it is intentionally NOT 0.0.0.0/0.
      vpnCidrs: (
        process.env["CDK_GENESIS_PROD_STAGING_VPN_CIDRS"] ?? "10.41.0.0/16"
      )
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      // Genesis-issued ACM cert (deploy region, NOT us-east-1) covering the apex +
      // *.apex, validated in Genesis's Route 53. Genesis supplies the ARN.
      albCertArn:
        process.env["CDK_GENESIS_PROD_STAGING_ALB_CERT_ARN"] ??
        "arn:aws:acm:us-west-2:000000000000:certificate/REPLACE-WITH-GENESIS-STAGING-CERT-ARN",
      adminAlias: "admin.axira-los-staging.genesiscapital.com",
      // Optional extra SNI cert for the admin host if Genesis issues a separate
      // (non-wildcard) cert. If their albCertArn already covers apex + *.apex, leave
      // CDK_GENESIS_PROD_STAGING_WILDCARD_CERT_ARN unset — the apex wildcard then
      // serves admin.* via SNI and no extra cert is added.
      additionalCertArns: process.env[
        "CDK_GENESIS_PROD_STAGING_WILDCARD_CERT_ARN"
      ]
        ? [process.env["CDK_GENESIS_PROD_STAGING_WILDCARD_CERT_ARN"] as string]
        : [],
    },
    // Cross-app runtime origins (injected as AXIRA_*_URL on the Next apps). This env
    // deploys ONLY two apps — experience (apex) + admin-hub (admin.<apex>) —
    // mirroring genesis-prod; customer-central + ops-console are separate apps not
    // in this deploy and are intentionally left unset.
    appUrls: {
      experienceUrl: "https://axira-los-staging.genesiscapital.com",
      adminHubUrl: "https://admin.axira-los-staging.genesiscapital.com",
    },
    // Single-customer staging: lock sign-in to the Genesis corporate email domain
    // across every connection, same as genesis-prod. Injected into the gateway +
    // experience INSTANCE_EMAIL_DOMAIN env + the experience NEXT_PUBLIC build-arg
    // (compute-stack), and applied Auth0-side by the deploy pipeline's auth0_setup
    // job from the matching instance_email_domain input.
    instanceEmailDomain: "genesiscapital.com",
    tags: {
      Project: "Axira",
      Environment: "staging",
      Owner: "axira-genesis-capital",
      ManagedBy: "cdk",
      CostCenter: "axira-genesis-prod-staging",
    },
    // Staging-tier topology. VPC 10.41/16 does not overlap genesis-prod's 10.40/16
    // (same Genesis account). Single NAT + 2 AZs mirror axira-los-staging.
    vpc: { cidr: "10.41.0.0/16", azCount: 2, natGateways: 1 },
    // Staging-tier data plane (mirrors axira-los-staging): small Aurora, no
    // multi-AZ, no read replica, no deletion protection.
    postgres: {
      auroraMinAcu: 0.5,
      auroraMaxAcu: 1,
      replicaCount: 0,
      multiAz: false,
      backupRetentionDays: 14,
      deletionProtection: false,
    },
    redis: {
      nodeType: "cache.t4g.medium",
      numShards: 1,
      replicasPerShard: 0,
      multiAz: false,
      snapshotRetentionDays: 7,
    },
    opensearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      masterNodeCount: 0,
      volumeGiB: 50,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
    openfga: openfgaConfig("genesis-prod-staging"),
    services: services("genesis-prod-staging"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // genesis-prod-staging — Genesis account, Bedrock standard (mirrors prod).
    llmProvider: "bedrock",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: baseSlo,
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: false,
      rateLimitPerIp: 2000,
    },
    retention: baseRetention,
    docs: docsConfig("genesis-prod-staging"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      ebsVolumeGiB: 50,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },

  // Axira-side STAGING environment. Staging-grade sizing on Axira's OWN identity
  // + domain (axira-los-staging.axiralabs.ai). Deployed into the SAME Axira AWS
  // account as axira-los prod (CDK_AXIRA_LOS_ACCOUNT at deploy time); every
  // resource is env-prefixed, so it coexists with axira-los + the legacy
  // axira-staging in one account without collision. VPC CIDR 10.22/16 does not
  // overlap axira-staging's 10.20/16 or axira-los's 10.21/16.
  "axira-los-staging": {
    name: "axira-los-staging",
    account: process.env["CDK_AXIRA_LOS_ACCOUNT"] ?? "000000000000",
    region: process.env["CDK_AXIRA_LOS_REGION"] ?? "us-west-2",
    domainName: "axira-los-staging.axiralabs.ai",
    hostedZoneName: "axira-los-staging.axiralabs.ai",
    hostedZoneOwnership: "create",
    httpsEnabled: false,
    usePlaceholderImage: false,
    // WARP-private edge (mirrors genesis-staging). No public ingress: a
    // cloudflared connector forwards WARP-routed traffic to the ALB, and the ALB
    // SG accepts only that connector. httpsEnabled stays false — the ALB cert is
    // supplied via privateAccess.albCertArn (us-west-2 ACM, Cloudflare-validated).
    // Reachable only on the axiralabs.ai WARP VPN (tunnel route 10.22.0.0/16).
    privateAccess: {
      enabled: true,
      aliases: ["axira-los-staging.axiralabs.ai"],
      adminAlias: "admin.axira-los-staging.axiralabs.ai",
      // One ACM cert covers apex + *.apex, so admin.* is served via SNI.
      albCertArn:
        process.env["CDK_AXIRA_LOS_STAGING_ALB_CERT_ARN"] ??
        "arn:aws:acm:us-west-2:000000000000:certificate/a5be43f3-7b13-41fe-8bee-94706a2637fa",
      tunnelTokenSecretArn:
        process.env["CDK_AXIRA_LOS_STAGING_CLOUDFLARED_TOKEN_ARN"] ??
        "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira/axira-los-staging/cloudflared-token-PBZigu",
    },
    // Cross-app runtime origins (injected as AXIRA_*_URL on the Next apps).
    // experience (apex) + admin-hub (admin.<apex>) auto-derive from the hosts
    // above and match the values this env used to BAKE into the bundle, so
    // staging is unaffected by the build-time→runtime move. customerCentralUrl is
    // pinned to the same `customer.<apex>` placeholder the bundle baked before
    // (its ECS service is not deployed yet, so the link still 404s — unchanged).
    appUrls: {
      customerCentralUrl: "https://customer.axira-los-staging.axiralabs.ai",
    },
    tags: {
      Project: "Axira",
      Environment: "staging",
      Owner: "axira-platform",
      ManagedBy: "cdk",
      CostCenter: "axira-los-staging",
    },
    vpc: { cidr: "10.22.0.0/16", azCount: 2, natGateways: 1 },
    postgres: {
      auroraMinAcu: 0.5,
      auroraMaxAcu: 1,
      replicaCount: 0,
      multiAz: false,
      backupRetentionDays: 14,
      deletionProtection: false,
    },
    redis: {
      nodeType: "cache.t4g.medium",
      numShards: 1,
      replicasPerShard: 0,
      multiAz: false,
      snapshotRetentionDays: 7,
    },
    opensearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      masterNodeCount: 0,
      volumeGiB: 50,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
    openfga: openfgaConfig("axira-los-staging"),
    services: services("axira-los-staging"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // axira-los-staging — AWS-India (AISPL); Bedrock-Anthropic blocked, use the direct Anthropic API
    llmProvider: "anthropic",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: baseSlo,
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: false,
      rateLimitPerIp: 2000,
    },
    retention: baseRetention,
    docs: docsConfig("axira-los-staging"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.small.search",
      dataNodeCount: 2,
      ebsVolumeGiB: 50,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    // Customer-side ops-emitter → Axira ops-plane (axira-los-staging customer).
    // Codifies the formerly hand-patched workflow-engine env so a `cdk deploy`
    // can no longer silently drop the Services/Errors feed. Endpoint + slug +
    // HMAC secret ARN are staging-specific; prod/Genesis set their own block.
    opsEmitter: {
      endpoint: "https://ops-staging.axiralabs.ai",
      customerSlug: "axira-los-staging",
      hmacSecretArn:
        process.env["CDK_AXIRA_LOS_STAGING_OPS_HMAC_SECRET_ARN"] ??
        "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira-ops/staging/customer/axira-los-staging/hmac-j5tUYb",
      errorGroupsEnabled: true,
      infraSignalCollectorEnabled: true,
      // <slug>=<in-cluster health URL> for the six customer-side services. DNS =
      // Cloud Map name (ECS service name minus `axira-`) under the axira.internal
      // namespace; port + path = each service's containerPort + health route.
      // alert-runner uses its new liveness server (ALERT_RUNNER_HEALTH_PORT 3014).
      serviceHealthUrls: [
        "gateway=http://gateway.axira.internal:3001/health",
        "agent-runtime=http://agent-runtime.axira.internal:3002/health",
        "experience=http://experience.axira.internal:3000/api/health",
        "workflow-engine=http://workflow-engine.axira.internal:3003/health",
        "admin-hub=http://admin-hub.axira.internal:3010/api/health",
        "observability-alert-runner=http://alert-runner.axira.internal:3014/health",
      ].join(","),
    },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },

  // Axira-side PRODUCTION environment. Prod-grade sizing (mirrors genesis-prod)
  // on Axira's OWN identity + domain (axira-los.axiralabs.ai). Deployed into the
  // SAME Axira AWS account as axira-los-staging (CDK_AXIRA_LOS_ACCOUNT at deploy
  // time); every resource is env-prefixed, so it coexists with axira-los-staging
  // + the legacy axira-staging in one account without collision. VPC CIDR
  // 10.21/16 does not overlap 10.20 (axira-staging) or 10.22 (axira-los-staging).
  "axira-los": {
    name: "axira-los",
    // A prior teardown left this env's AM audit-archive bucket COMPLIANCE-locked
    // (WORM, undeletable by anyone until retention expires), which blocks
    // recreating it under the canonical name. Suffix the bucket so a redeploy
    // provisions a clean one; the orphaned WORM bucket is harmless + self-expires.
    auditArchiveSuffix: "v2",
    account: process.env["CDK_AXIRA_LOS_ACCOUNT"] ?? "000000000000",
    region: process.env["CDK_AXIRA_LOS_REGION"] ?? "us-west-2",
    domainName: "axira-los.axiralabs.ai",
    hostedZoneName: "axira-los.axiralabs.ai",
    hostedZoneOwnership: "create",
    httpsEnabled: false,
    usePlaceholderImage: false,
    // WARP-private edge (mirrors genesis-staging). No public ingress; reachable
    // only on the axiralabs.ai WARP VPN (tunnel route 10.21.0.0/16). ALB cert is
    // supplied via privateAccess.albCertArn (us-west-2 ACM, Cloudflare-validated).
    privateAccess: {
      enabled: true,
      aliases: ["axira-los.axiralabs.ai"],
      adminAlias: "admin.axira-los.axiralabs.ai",
      // One ACM cert covers apex + *.apex, so admin.* is served via SNI.
      albCertArn:
        process.env["CDK_AXIRA_LOS_ALB_CERT_ARN"] ??
        "arn:aws:acm:us-west-2:000000000000:certificate/9d79eac4-3603-4abd-8442-a553d17fdd2f",
      tunnelTokenSecretArn:
        process.env["CDK_AXIRA_LOS_CLOUDFLARED_TOKEN_ARN"] ??
        "arn:aws:secretsmanager:us-west-2:000000000000:secret:axira/axira-los/cloudflared-token-qM3Z5K",
    },
    // Cross-app runtime origins (injected as AXIRA_*_URL on the Next apps). This
    // env deploys ONLY two apps — experience (apex) + admin-hub (admin.<apex>).
    // customer-central + ops-console are SEPARATE apps not in this deploy, so
    // they are intentionally left unset (the apps fall back to the inert dev
    // default and never link to a non-existent host).
    appUrls: {
      experienceUrl: "https://axira-los.axiralabs.ai",
      adminHubUrl: "https://admin.axira-los.axiralabs.ai",
    },
    tags: {
      Project: "Axira",
      Environment: "production",
      Owner: "axira-platform",
      ManagedBy: "cdk",
      CostCenter: "axira-los",
    },
    vpc: { cidr: "10.21.0.0/16", azCount: 3, natGateways: 3 },
    postgres: {
      auroraMinAcu: 1,
      auroraMaxAcu: 8,
      replicaCount: 1,
      multiAz: true,
      backupRetentionDays: 35,
      deletionProtection: true,
    },
    redis: {
      nodeType: "cache.r7g.large",
      numShards: 1,
      replicasPerShard: 1,
      multiAz: true,
      snapshotRetentionDays: 14,
    },
    opensearch: {
      dataNodeInstanceType: "t3.medium.search",
      dataNodeCount: 3,
      masterNodeCount: 0,
      volumeGiB: 100,
      multiAz: true,
      warmStorage: false,
    },
    temporal: { cpu: 2048, memoryMiB: 4096, desiredCount: 3 },
    openfga: openfgaConfig("axira-los"),
    services: services("axira-los"),
    sqsQueues: STANDARD_SQS_QUEUES,
    snsDomains: ALL_SNS_DOMAINS,
    buckets: BUCKETS_PLATFORM,
    providerSecrets: PROVIDER_SECRETS,
    // axira-los prod — US account, Bedrock standard
    llmProvider: "bedrock",
    bedrock: {
      allowedModelIds: bedrockModels,
      routerModelId: ROUTER_MODEL_ID,
      extractionModelId: EXTRACTION_MODEL_ID,
    },
    slo: { ...baseSlo, availabilityTarget: 0.9995 },
    waf: {
      enableAwsCommon: true,
      enableAwsKnownBadInputs: true,
      enableAnonymousIpBlock: true,
      rateLimitPerIp: 6000,
    },
    retention: { ...baseRetention, logRetentionDays: 90 },
    docs: docsConfig("axira-los"),
    logsOpenSearch: {
      dataNodeInstanceType: "t3.medium.search",
      dataNodeCount: 3,
      ebsVolumeGiB: 100,
    },
    opsPlane: { opsSubdomain: "ops", consoleSubdomain: "console" },
    phoenixEndpoint: "https://phoenix.axira.local/v1/traces",
    featureFlags: {
      cedarAuthzEnabled: true,
      amEnforcementEnabled: true,
      authorityMatrixEnabled: true,
      authorityMatrixStrict: true,
      obsDynamicLevelEnabled: true,
    },
  },
};

export function loadEnv(envName: string | undefined): EnvConfig {
  if (!envName) {
    throw new Error(
      "CDK env not specified. Pass with: cdk -c env=axira-staging|axira-los-staging|axira-los|genesis-staging|genesis-prod|genesis-prod-staging",
    );
  }
  const cfg = ENVS[envName as EnvName];
  if (!cfg) {
    throw new Error(
      `Unknown env '${envName}'. Valid: ${Object.keys(ENVS).join(", ")}`,
    );
  }
  return cfg;
}

export function resourcePrefix(env: EnvConfig): string {
  return env.name;
}
