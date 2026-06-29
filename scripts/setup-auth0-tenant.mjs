#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
// scripts/setup-auth0-tenant.mjs — codify the GENESIS-tenant Auth0 config so a
// production bring-up needs ZERO dashboard clicks.
// ════════════════════════════════════════════════════════════════════════════
//
// Auth0 has no deploy-from-repo pipeline, so the passwordless-OTP grant on the
// web/SPA app, the passwordless EMAIL connection, the three post-login Actions,
// and their binding order all used to be hand-set in the dashboard. This script
// does all of it idempotently through the Management API (read-modify-write;
// PATCH only when something actually changes; safe to re-run). The ONLY
// /connections it touches is the built-in passwordless EMAIL connection (the
// founding-admin bootstrap mints users on it — see below); the okta-workforce
// ENTERPRISE connections stay owned by the runtime Mgmt client at
// apps/gateway/src/gateways/identity/auth0-mgmt.ts.
//
// Rate limits: the script bursts many Management API calls, which can trip
// Auth0's GLOBAL per-second limit (HTTP 429) even after a write already
// succeeded — a transient 429 must NOT fail the deploy. The shared api() helper
// retries 429s (honoring Retry-After, else exponential backoff + jitter, max 5)
// and applies a small proactive inter-call throttle; see api() / rateLimitDelayMs.
//
// What it does (in order):
//   1. Mint a Management API token (client_credentials).
//   2. Web app passwordless-OTP grant: union the passwordless/otp grant type
//      into the web app's grant_types (so email-OTP login works).
//   2c. Passwordless EMAIL connection: ensure the built-in `email` (strategy
//      `email`) connection EXISTS and that its CALLING CLIENTS are ENABLED on it
//      (set via the dedicated connection-clients sub-resource
//      PATCH /connections/{id}/clients [{ client_id, status:true }, …] — NOT via
//      the connection body, which no longer accepts `enabled_clients`). The
//      first-admin bootstrap mints the founding admin on this connection via the
//      Management API (createUser connection:"email", domains/platform
//      .../auth0-user-provisioner.impl.ts). Auth0 gates single-user creation
//      PER CALLING CLIENT and rejects with 400 ("Connection must be enabled for
//      this client to perform single user creation …", auth0_idp_error) when the
//      client whose token makes the POST /api/v2/users call is not enabled — and
//      that caller is the MANAGEMENT M2M app (AUTH0_MGMT_CLIENT_ID), NOT the web
//      app. So this step enables the Mgmt M2M app (the create-user caller), the
//      web/SPA app (for /passwordless/start + verify), and the optional
//      provisioning M2M app. A disabled caller 500s /v1/control/tenants/provision
//      and surfaces as "An unexpected error occurred" at the /passwordless/start
//      step of login. See ensurePasswordlessEmailConnection(). (Staging had this
//      enabled by hand; prod did not — this codifies it.)
//   2b. identity:resolve client-grant (G2): ensure the Core API resource
//      server (audience CORE_API_AUDIENCE) declares the `identity:resolve`
//      scope, AND create/repair the client-grant for the org/user-provisioning
//      M2M app (AUTH0_M2M_CLIENT_ID) on that audience with that scope — so the
//      post-login Action's M2M call to /v1/internal/identity/sync-login mints a
//      token carrying identity:resolve. Skipped (loud) when AUTH0_M2M_CLIENT_ID
//      is unset. See ensureIdentityResolveGrant().
//   3. Deploy the three post-login Actions from infra/auth0/genesis/actions/:
//        instance-domain-lock, resolve-axira-roles, set-axira-claims
//      (create if missing, else PATCH {code}; then WAIT for the async build to
//      reach the 'built' state — Auth0 builds drafts asynchronously and /deploy
//      400s on a not-yet-built draft — then POST /deploy). This step is
//      BEST-EFFORT: a single Action's create/build/deploy failure WARNS and
//      CONTINUES rather than aborting the whole setup (so the REQUIRED steps
//      above are never stranded); a re-run reconciles any that failed.
//   3b. (OPT-IN, OFF BY DEFAULT) Set the INSTANCE_EMAIL_DOMAIN secret on the
//      "Instance Domain Lock" Action — ONLY when INSTANCE_EMAIL_DOMAIN is
//      passed in the env. Unset ⇒ the Action stays inert (allows every email
//      domain). See the LOUD WARNING block in ensureInstanceDomainLockSecret().
//   4. Set the post-login binding order:
//        instance-domain-lock → resolve-axira-roles → set-axira-claims
//
// ── Required env ─────────────────────────────────────────────────────────────
//   AUTH0_DOMAIN              tenant domain, no scheme/slash
//   AUTH0_MGMT_CLIENT_ID      a Machine-to-Machine app authorized for the
//   AUTH0_MGMT_CLIENT_SECRET  Auth0 Management API (read/update clients +
//                             actions; read/update trigger bindings)
//   AUTH0_WEB_APP_CLIENT_ID   the SPA/web (experience + admin-hub) app whose
//                             grant_types need the passwordless/otp entry
//
// ── Optional env (identity:resolve client-grant — G2) ────────────────────────
//   AUTH0_M2M_CLIENT_ID       the org/user-provisioning Machine-to-Machine app
//                             (the `auth0-m2m` secret's clientId) that the
//                             post-login Action authenticates as when calling
//                             /v1/internal/identity/sync-login. This script
//                             declares the `identity:resolve` scope on the Core
//                             API resource server and grants it to this M2M app.
//                             UNSET ⇒ the grant step is skipped (loud warning);
//                             federated provision-on-login then can't mint the
//                             scope, so set it for any env that uses Okta SSO.
//   CORE_API_AUDIENCE         the Core API resource-server identifier the M2M
//                             token is minted for. Defaults to the platform's
//                             AUTH0_AUDIENCE value, https://api.axiralabs.ai.
//
// ── Optional env (instance domain-lock enforcement — SECURITY-SENSITIVE) ──────
//   INSTANCE_EMAIL_DOMAIN     the customer email domain this deployment serves
//                             (comma-separated list allowed for multi-brand).
//                             When SET, this script stamps it as the Action
//                             secret so the IdP refuses sign-in for ANY user
//                             whose email domain is not in the list — ACROSS
//                             ALL connections (Okta, OIDC, passwordless, …).
//                             When UNSET (the default), the lock stays inert
//                             and this script changes nothing about it.
//
//                             ⚠  ENABLING THIS REJECTS EVERY TESTER WHOSE OKTA
//                                EMAIL IS NOT IN THE DOMAIN LIST. On staging,
//                                federated testers sign in with their real Okta
//                                profile email (e.g. vignesh@thinkql.com), NOT
//                                the @axiralabs.app HRD routing domain — so
//                                setting INSTANCE_EMAIL_DOMAIN=axiralabs.app
//                                LOCKS THOSE TESTERS OUT until their Okta email
//                                is changed to @axiralabs.app. Recommended: ON
//                                for the single-tenant Genesis prod bring-up;
//                                leave UNSET on shared staging.
//                             Also set the SAME value as the gateway +
//                             Experience env var INSTANCE_EMAIL_DOMAIN (read by
//                             @axira/auth `isEmailAllowedForInstance`, the
//                             resolve-idp route, the BFF, and the login form)
//                             so all four enforcement surfaces agree.
//
// ── How to run ───────────────────────────────────────────────────────────────
//   STAGING (axiralabs.us.auth0.com):
//     AUTH0_DOMAIN=axiralabs.us.auth0.com \
//     AUTH0_MGMT_CLIENT_ID=<staging mgmt m2m client id> \
//     AUTH0_MGMT_CLIENT_SECRET=<staging mgmt m2m client secret> \
//     AUTH0_WEB_APP_CLIENT_ID=<staging web/SPA app client id> \
//     node scripts/setup-auth0-tenant.mjs
//
//   PROD (axiralabs-prod.us.auth0.com):
//     AUTH0_DOMAIN=axiralabs-prod.us.auth0.com \
//     AUTH0_MGMT_CLIENT_ID=<prod mgmt m2m client id> \
//     AUTH0_MGMT_CLIENT_SECRET=<prod mgmt m2m client secret> \
//     AUTH0_WEB_APP_CLIENT_ID=<prod web/SPA app client id> \
//     node scripts/setup-auth0-tenant.mjs
//
//   The Mgmt M2M client id/secret + web app client id come from the env's
//   secrets JSON (axira/<env>/auth0-mgmt + axira/<env>/auth0). This script only
//   reads env vars; it never reads Secrets Manager directly.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACTIONS_DIR = join(ROOT, "infra", "auth0", "genesis", "actions");

const out = (s) => process.stdout.write(`${s}\n`);
const die = (s) => {
  process.stderr.write(`✗ ${s}\n`);
  process.exit(1);
};

// ── Inputs ───────────────────────────────────────────────────────────────────
const DOMAIN = process.env.AUTH0_DOMAIN;
const MGMT_CLIENT_ID = process.env.AUTH0_MGMT_CLIENT_ID;
const MGMT_CLIENT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET;
const WEB_APP_CLIENT_ID = process.env.AUTH0_WEB_APP_CLIENT_ID;
// OPTIONAL (G2). The org/user-provisioning M2M app that the post-login Action
// authenticates as. Unset ⇒ the identity:resolve grant step is skipped (loud).
const M2M_CLIENT_ID = (process.env.AUTH0_M2M_CLIENT_ID ?? "").trim();
// OPTIONAL (G2). Core API resource-server identifier the M2M token targets.
// Defaults to the platform's AUTH0_AUDIENCE (https://api.axiralabs.ai).
const CORE_API_AUDIENCE = (
  process.env.CORE_API_AUDIENCE ?? "https://api.axiralabs.ai"
).trim();
// OPTIONAL + SECURITY-SENSITIVE. Unset ⇒ instance domain-lock untouched/inert.
const INSTANCE_EMAIL_DOMAIN = (process.env.INSTANCE_EMAIL_DOMAIN ?? "").trim();

for (const [name, val] of [
  ["AUTH0_DOMAIN", DOMAIN],
  ["AUTH0_MGMT_CLIENT_ID", MGMT_CLIENT_ID],
  ["AUTH0_MGMT_CLIENT_SECRET", MGMT_CLIENT_SECRET],
  ["AUTH0_WEB_APP_CLIENT_ID", WEB_APP_CLIENT_ID],
]) {
  if (typeof val !== "string" || val.length === 0) {
    die(`missing required env ${name}`);
  }
}

const INSTANCE_DOMAIN_LOCK_ACTION = "Instance Domain Lock";
const INSTANCE_EMAIL_DOMAIN_SECRET = "INSTANCE_EMAIL_DOMAIN";

const API = `https://${DOMAIN}/api/v2`;
const PASSWORDLESS_OTP_GRANT =
  "http://auth0.com/oauth/grant-type/passwordless/otp";

// 2c — the built-in passwordless EMAIL connection the first-admin bootstrap
// mints users on. Name is configurable to match the gateway/provisioner env
// AUTH0_PASSWORDLESS_EMAIL_CONNECTION (apps/gateway .../container.ts +
// domains/platform .../auth0-user-provisioner.impl.ts), which defaults to
// "email" — Auth0's built-in passwordless email connection name.
const PASSWORDLESS_EMAIL_CONNECTION = (
  process.env.AUTH0_PASSWORDLESS_EMAIL_CONNECTION ?? "email"
).trim();

// G2 — the scope the post-login resolve-roles M2M call needs. The gateway's
// /v1/internal/identity/sync-login route gates on this scope being present in
// the validated M2M JWT (resolve-roles + app_metadata sync).
const IDENTITY_RESOLVE_SCOPE = "identity:resolve";
const IDENTITY_RESOLVE_SCOPE_DESCRIPTION =
  "Resolve user roles at login (provision-on-login)";

// G2 — display name for the Core API resource server when this script has to
// CREATE it (a fresh tenant — e.g. Genesis prod — that never had it set up by
// hand). This mirrors the "Axira Core API" the staging tenant was given via the
// dashboard per docs/playbooks/auth0-okta-federation.md § 1. The audience
// (identifier) is CORE_API_AUDIENCE; the gateway's AUTH0_AUDIENCE points at the
// same value, so M2M + user tokens minted against it validate cleanly (RS256
// via JWKS, see packages/auth/src/jwt.ts). RBAC is intentionally left OFF: the
// platform resolves permissions via OpenFGA, NOT from token scopes/permissions
// (apps/gateway/src/plugins/auth.ts Layer 4); the only resource-server scope it
// consumes is identity:resolve (apps/gateway/src/gateways/identity/internal-routes.ts).
const CORE_API_NAME = "Axira Core API";

// The three post-login Actions, in the order they must run. The display name
// is what binds in the trigger and is matched against the live action list.
const ACTIONS = [
  { name: "Instance Domain Lock", file: "instance-domain-lock.cjs" },
  { name: "Resolve Axira Roles", file: "resolve-axira-roles.cjs" },
  { name: "Set Axira Claims", file: "set-axira-claims.cjs" },
];

// ── HTTP helper (plain fetch + bearer; mirrors the repo's other .mjs scripts) ─
let MGMT_TOKEN = null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 429 retry/backoff tuning. The script fires many Management API calls in a
// burst (clients, resource-servers, actions, triggers, …) and can trip Auth0's
// GLOBAL per-second rate limit, which returns HTTP 429 even though each
// individual write succeeded. A transient 429 must NOT fail the deploy
// (critical for the Genesis bring-up), so api() retries 429s below.
const RATELIMIT_MAX_RETRIES = 5; // attempts AFTER the first try
const RATELIMIT_BASE_MS = 1000; // exponential base (1s, 2s, 4s, 8s, 16s)
const RATELIMIT_MAX_BACKOFF_MS = 30000; // cap a single wait
// Small proactive inter-call throttle to stay under the global per-second
// limit. Cheap insurance; the 429 retry is the real guarantee. Set
// AUTH0_SETUP_THROTTLE_MS=0 to disable (e.g. local runs against a quiet tenant).
const INTER_CALL_THROTTLE_MS = (() => {
  const raw = (process.env.AUTH0_SETUP_THROTTLE_MS ?? "").trim();
  if (raw.length === 0) return 120; // default ~8 calls/s headroom
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 120;
})();

// Resolve how long to wait before retrying a 429. Auth0 sends `Retry-After` in
// SECONDS (and sometimes an X-RateLimit-Reset epoch); honor it when present and
// sane, else fall back to exponential backoff with jitter. `attempt` is 0-based
// (the count of retries already performed).
function rateLimitDelayMs(res, attempt) {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number.parseFloat(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      // +250ms guard so we resume just AFTER the window, capped.
      return Math.min(secs * 1000 + 250, RATELIMIT_MAX_BACKOFF_MS);
    }
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSec = Number.parseInt(reset, 10);
    if (Number.isFinite(epochSec)) {
      const deltaMs = epochSec * 1000 - Date.now();
      if (deltaMs > 0) {
        return Math.min(deltaMs + 250, RATELIMIT_MAX_BACKOFF_MS);
      }
    }
  }
  // Exponential backoff + jitter (full jitter up to 250ms).
  const backoff = Math.min(
    RATELIMIT_BASE_MS * 2 ** attempt,
    RATELIMIT_MAX_BACKOFF_MS,
  );
  return backoff + Math.floor(Math.random() * 250);
}

async function api(method, path, body) {
  // Proactive throttle to reduce hitting the global per-second limit.
  if (INTER_CALL_THROTTLE_MS > 0) await wait(INTER_CALL_THROTTLE_MS);

  let res;
  let text;
  // attempt 0 is the first try; retries 1..RATELIMIT_MAX_RETRIES handle 429.
  for (let attempt = 0; ; attempt += 1) {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${MGMT_TOKEN}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // Retry ONLY on 429 (transient global rate limit), honoring Retry-After
    // when present, else exponential backoff. Any other status (incl. other
    // 4xx/5xx) falls straight through to the parse + non-ok throw below.
    if (res.status === 429 && attempt < RATELIMIT_MAX_RETRIES) {
      const delayMs = rateLimitDelayMs(res, attempt);
      out(
        `  · 429 rate-limited on ${method} ${path} — retry ${
          attempt + 1
        }/${RATELIMIT_MAX_RETRIES} in ${delayMs}ms`,
      );
      // Drain the body so the connection can be reused.
      await res.text().catch(() => "");
      await wait(delayMs);
      continue;
    }
    text = await res.text();
    break;
  }

  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    // After exhausting retries (or for any non-429 error) fail loudly with the
    // final status + body so the operator sees the real cause.
    throw new Error(
      `${method} ${path} → ${res.status}: ${
        typeof parsed === "object" ? JSON.stringify(parsed) : text
      }`.slice(0, 500),
    );
  }
  return parsed;
}

// ── 1. Mint a Management API token ───────────────────────────────────────────
async function mintMgmtToken() {
  const res = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: MGMT_CLIENT_ID,
      client_secret: MGMT_CLIENT_SECRET,
      audience: `https://${DOMAIN}/api/v2/`,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    die(`could not mint Mgmt token (${res.status}): ${text.slice(0, 300)}`);
  }
  const token = JSON.parse(text).access_token;
  if (!token) die("Mgmt /oauth/token returned no access_token");
  return token;
}

// ── 2. Web app config: passwordless-OTP grant + RS256 ID-token alg ───────────
async function ensureWebAppConfig() {
  out("\n▶ Web app config (passwordless-OTP grant + RS256 ID-token alg)");
  const client = await api("GET", `/clients/${WEB_APP_CLIENT_ID}`);
  const patch = {};

  // (a) passwordless-OTP grant — so email-OTP login works.
  const grants = Array.isArray(client.grant_types) ? client.grant_types : [];
  if (!grants.includes(PASSWORDLESS_OTP_GRANT)) {
    patch.grant_types = [...grants, PASSWORDLESS_OTP_GRANT];
    out(
      `  · adding passwordless/otp grant (${grants.length} → ${patch.grant_types.length})`,
    );
  } else {
    out("  · passwordless/otp grant already present");
  }

  // (b) RS256 ID-token signature alg — @auth0/nextjs-auth0 validates the ID
  //     token against the JWKS public key and REQUIRES RS256. An unset/HS256
  //     alg makes the SDK callback fail with HTTP 400 "unexpected JWT alg
  //     received, expected RS256, got: HS256" (a regular_web app can default
  //     to HS256). Force RS256.
  const jc = client.jwt_configuration || {};
  if (jc.alg !== "RS256") {
    const nextJc = { ...jc, alg: "RS256" };
    delete nextJc.secret_encoded; // read-only field
    patch.jwt_configuration = nextJc;
    out(`  · setting ID-token alg ${jc.alg ?? "<unset>"} → RS256`);
  } else {
    out("  · ID-token alg already RS256");
  }

  if (Object.keys(patch).length === 0) {
    out(`  · already configured on ${WEB_APP_CLIENT_ID} — no change`);
    return false;
  }
  await api("PATCH", `/clients/${WEB_APP_CLIENT_ID}`, patch);
  out("  ✓ web app config updated");
  return true;
}

// ── 2c. Passwordless EMAIL connection enabled for its calling clients ─────────
//
// The first-admin bootstrap mints the founding admin's Auth0 identity on the
// built-in passwordless EMAIL connection via the Management API
// (createUser connection:"email" — domains/platform .../auth0-user-provisioner
// .impl.ts, called by apps/gateway POST /v1/control/tenants/provision). Auth0's
// POST /api/v2/users returns 400 when the connection is not enabled for the
// client whose token makes the request:
//   "Connection must be enabled for this client to perform single user
//    creation and signup operations (client_id: … - connection: email)"
//   (errorCode auth0_idp_error).
// That 400 propagates as a 500 from /v1/control/tenants/provision, which the
// experience app's /api/auth/passwordless/start route faithfully relays —
// surfacing as "An unexpected error occurred." at the `start` step of /login.
//
// CRITICAL — single-user creation is gated PER CALLING CLIENT, not just the web
// app. There are THREE distinct Auth0 clients in play and they need DIFFERENT
// access to this connection:
//   • The Management-API M2M app (AUTH0_MGMT_CLIENT_ID) is the client whose
//     token the gateway's Auth0ManagementClient uses for POST /api/v2/users.
//     THIS is the client Auth0 checks for the single-user-creation gate above.
//     It MUST be enabled on the connection or the bootstrap's createUser 400s.
//   • The web/SPA app (AUTH0_WEB_APP_CLIENT_ID) is the client the browser uses
//     for /passwordless/start (send OTP) + the verify token exchange. It must
//     also be enabled so the OTP step (step 2 of the start route) can run.
//   • The optional provisioning M2M app (AUTH0_M2M_CLIENT_ID, the post-login
//     Action identity) — enabled best-effort when present, so any future
//     server-side user mint from that identity isn't gated either. Harmless if
//     it never creates users.
// Enabling ONLY the web app (the previous behaviour) left the Mgmt M2M app
// disabled → the createUser 400 persisted even though the web app showed as
// enabled.
//
// API SURFACE — enabled clients live on a DEDICATED connection-clients
// sub-resource, NOT on the connection body. Auth0 removed `enabled_clients`
// from PATCH /connections/{id}: sending it now 400s with
//   "Payload validation error: 'Additional properties not allowed:
//    enabled_clients'" (errorCode invalid_body).
// The correct surface (Auth0 Management API v2):
//   • READ : GET   /connections/{id}/clients  → { clients: [{ client_id }],
//            next? }  — checkpoint pagination via take (default 50, max 1000)
//            + from=<next>; iterate until `next` is absent.
//   • WRITE: PATCH /connections/{id}/clients  with body
//            [{ client_id, status: true }, …]  — an UPSERT of per-client
//            statuses (status true = enabled), max 50 items/request. It does
//            NOT replace the whole list, so we send ONLY the clients we're
//            enabling and leave any other already-enabled clients untouched.
//
// This step makes a prod bring-up need ZERO dashboard clicks for that connection:
//   1. Find the passwordless connection (strategy "email", named
//      PASSWORDLESS_EMAIL_CONNECTION). CREATE it if a fresh tenant never had it
//      (mirrors ensureCoreApiResourceServer's create-if-absent path).
//   2. Read the connection's enabled clients (paginated); enable any of the
//      required clients (Mgmt M2M + web app + optional provisioning M2M) that
//      are missing via the sub-resource (idempotent — a re-run with all already
//      enabled no-ops).
async function ensurePasswordlessEmailConnection() {
  out("\n▶ Passwordless EMAIL connection (calling clients enabled)");
  out(`  · connection: ${PASSWORDLESS_EMAIL_CONNECTION} (strategy email)`);

  // The clients that talk to this connection and therefore must be enabled.
  // Mgmt M2M is the create-user caller (the actual bootstrap fix); web app runs
  // /passwordless/start + verify; provisioning M2M is enabled best-effort when
  // configured. De-dupe in case any two secrets resolve to the same client_id.
  const requiredClients = [
    ["mgmt M2M (create-user caller)", MGMT_CLIENT_ID],
    ["web app", WEB_APP_CLIENT_ID],
    ...(M2M_CLIENT_ID.length > 0 ? [["provisioning M2M", M2M_CLIENT_ID]] : []),
  ].filter(([, id]) => typeof id === "string" && id.length > 0);
  const requiredIds = [...new Set(requiredClients.map(([, id]) => id))];

  // 1) Find the email-strategy connection by name. The strategy filter narrows
  //    to passwordless email connections; match the configured name in case a
  //    tenant has more than one.
  const list = await api(
    "GET",
    `/connections?strategy=email&per_page=100&include_fields=true`,
  );
  const arr = Array.isArray(list) ? list : (list.connections ?? []);
  let conn = arr.find((c) => c.name === PASSWORDLESS_EMAIL_CONNECTION);

  let missing = requiredIds;
  if (!conn) {
    // Not found ⇒ create the bare connection (enabled clients are set on the
    // sub-resource below — the create body does not accept them). otp/email
    // match Auth0's built-in passwordless email connection defaults;
    // disable_signup:false lets the bootstrap's createUser mint the founding
    // admin. Nothing is enabled yet, so all required clients are missing.
    out(
      `  · creating passwordless email connection "${PASSWORDLESS_EMAIL_CONNECTION}" …`,
    );
    conn = await api("POST", `/connections`, {
      name: PASSWORDLESS_EMAIL_CONNECTION,
      strategy: "email",
      options: { disable_signup: false },
    });
    out(`  ✓ created email connection ${conn.id ?? "(id n/a)"}`);
  } else {
    // 2) Exists ⇒ which required clients are not yet enabled? Page through the
    //    sub-resource (checkpoint pagination: take + from=<next>).
    const enabled = await listEnabledConnectionClients(conn.id);
    missing = requiredIds.filter((id) => !enabled.includes(id));
    if (missing.length === 0) {
      out(
        `  · all required clients already enabled on "${PASSWORDLESS_EMAIL_CONNECTION}" (${enabled.length} client(s)) — no change`,
      );
      return false;
    }
  }

  // Enable the missing clients via the dedicated sub-resource. The PATCH upserts
  // only the statuses we send (true) and leaves every other client untouched.
  const labelFor = (id) =>
    requiredClients.find(([, cid]) => cid === id)?.[0] ?? "client";
  await api(
    "PATCH",
    `/connections/${conn.id}/clients`,
    missing.map((id) => ({ client_id: id, status: true })),
  );
  for (const id of missing) {
    out(
      `  ✓ enabled ${labelFor(id)} (${id}) on "${PASSWORDLESS_EMAIL_CONNECTION}"`,
    );
  }
  out(`  ✓ via /connections/${conn.id}/clients`);
  return true;
}

// Read every client_id enabled on a connection via the connection-clients
// sub-resource. GET /connections/{id}/clients returns { clients: [{ client_id
// }], next? } with checkpoint pagination — omit `from` on the first call, then
// pass the returned `next` token until it is absent. Returns the flat list of
// enabled client_ids. (`take` max is 1000; we use 100 to bound per-page size.)
async function listEnabledConnectionClients(connectionId) {
  const ids = [];
  let from;
  for (;;) {
    const qs = from ? `take=100&from=${encodeURIComponent(from)}` : `take=100`;
    const page = await api("GET", `/connections/${connectionId}/clients?${qs}`);
    const clients = Array.isArray(page?.clients) ? page.clients : [];
    for (const c of clients) {
      if (c && typeof c.client_id === "string") ids.push(c.client_id);
    }
    const next = typeof page?.next === "string" ? page.next : "";
    if (next.length === 0) break;
    from = next;
  }
  return ids;
}

// ── 2b. identity:resolve client-grant (G2) ───────────────────────────────────
//
// The post-login "Resolve Axira Roles" Action calls the gateway's
// /v1/internal/identity/sync-login over an M2M token. That route gates on the
// `identity:resolve` scope. Auth0 only mints a scope into an M2M token when (a)
// the scope is DECLARED on the target resource server, AND (b) a client-grant
// authorizes this M2M app for that scope on that audience. This step codifies
// ALL of it idempotently so a prod bring-up needs ZERO dashboard clicks:
//
//   0. ENSURE the Core API resource server (identifier == CORE_API_AUDIENCE)
//      EXISTS — CREATE it if a fresh tenant (e.g. Genesis prod) never had it
//      set up by hand. See ensureCoreApiResourceServer().
//   1. Find the Core API resource server by its identifier (CORE_API_AUDIENCE);
//      union `identity:resolve` into its scopes if absent (PATCH).
//   2. List /client-grants?client_id=<m2m>&audience=<core>:
//        • exists but lacks identity:resolve → PATCH (union the scope).
//        • exists with the scope               → no-op.
//        • absent                              → POST a new grant.
//
// Skipped (loud) when AUTH0_M2M_CLIENT_ID is unset — the OTP grant + Actions
// still apply, but federated provision-on-login can't mint the scope, so set
// AUTH0_M2M_CLIENT_ID for any env that federates with Okta.

// ── Idempotently ensure the Core API resource server exists ──────────────────
//
// Page through /resource-servers and return the one whose identifier matches
// CORE_API_AUDIENCE. If none matches, CREATE it (the fresh-tenant path: a prod
// bring-up — e.g. Genesis — whose Auth0 tenant only has the default Management
// API). The staging tenant got this resource server by hand once (per
// docs/playbooks/auth0-okta-federation.md § 1); this codifies the same so no
// tenant ever needs the dashboard. Re-runnable: existing ⇒ returned untouched
// (the caller reconciles scopes); absent ⇒ created with identity:resolve and
// RS256, then returned. Returns the resource-server object.
async function ensureCoreApiResourceServer() {
  // The list endpoint paginates; page through (per_page=100) defensively.
  const servers = [];
  let page = 0;
  for (;;) {
    const batch = await api(
      "GET",
      `/resource-servers?per_page=100&page=${page}&include_totals=false`,
    );
    const arr = Array.isArray(batch) ? batch : (batch.resource_servers ?? []);
    servers.push(...arr);
    if (!Array.isArray(arr) || arr.length < 100) break;
    page += 1;
  }

  const existing = servers.find((s) => s.identifier === CORE_API_AUDIENCE);
  if (existing) {
    out(`  · resource server present: ${existing.id} (${existing.name})`);
    return existing;
  }

  // Not found ⇒ create it. signing_alg RS256 (the gateway validates RS256 via
  // JWKS); declare identity:resolve up front (the caller's scope-reconcile then
  // no-ops). RBAC stays OFF — the platform reads permissions from OpenFGA, not
  // the token (apps/gateway/src/plugins/auth.ts), so enforce_policies /
  // token_dialect are intentionally left at Auth0's defaults (off).
  out(
    `  · creating Core API resource server (identifier "${CORE_API_AUDIENCE}", RS256) …`,
  );
  const created = await api("POST", `/resource-servers`, {
    name: CORE_API_NAME,
    identifier: CORE_API_AUDIENCE,
    signing_alg: "RS256",
    scopes: [
      {
        value: IDENTITY_RESOLVE_SCOPE,
        description: IDENTITY_RESOLVE_SCOPE_DESCRIPTION,
      },
    ],
  });
  out(`  ✓ created Core API resource server ${created.id ?? "(id n/a)"}`);
  return created;
}

async function ensureIdentityResolveGrant() {
  out("\n▶ identity:resolve client-grant (Core API M2M)");
  if (M2M_CLIENT_ID.length === 0) {
    out(
      "  · AUTH0_M2M_CLIENT_ID unset — SKIPPING the identity:resolve grant. " +
        "Federated provision-on-login (/v1/internal/identity/sync-login) will " +
        "lack the scope. Set AUTH0_M2M_CLIENT_ID (the auth0-m2m clientId) for " +
        "any env that uses Okta SSO.",
    );
    return false;
  }
  out(`  · Core API audience: ${CORE_API_AUDIENCE}`);
  out(`  · M2M app:           ${M2M_CLIENT_ID}`);

  // 0) Ensure the Core API resource server EXISTS (create it on a fresh tenant
  //    that never had it set up by hand), then 1) ensure the scope is declared.
  const core = await ensureCoreApiResourceServer();

  const scopes = Array.isArray(core.scopes) ? core.scopes : [];
  const hasScope = scopes.some((s) => s.value === IDENTITY_RESOLVE_SCOPE);
  if (!hasScope) {
    await api("PATCH", `/resource-servers/${core.id}`, {
      scopes: [
        ...scopes,
        {
          value: IDENTITY_RESOLVE_SCOPE,
          description: IDENTITY_RESOLVE_SCOPE_DESCRIPTION,
        },
      ],
    });
    out(
      `  ✓ declared ${IDENTITY_RESOLVE_SCOPE} on the Core API resource server`,
    );
  } else {
    out(`  · ${IDENTITY_RESOLVE_SCOPE} scope already declared on Core API`);
  }

  // 2) Ensure the M2M app's client-grant for this audience carries the scope.
  const grantsRaw = await api(
    "GET",
    `/client-grants?client_id=${encodeURIComponent(
      M2M_CLIENT_ID,
    )}&audience=${encodeURIComponent(CORE_API_AUDIENCE)}`,
  );
  const grants = Array.isArray(grantsRaw)
    ? grantsRaw
    : (grantsRaw.client_grants ?? []);

  if (grants.length > 0) {
    const grant = grants[0];
    const grantScopes = Array.isArray(grant.scope) ? grant.scope : [];
    if (!grantScopes.includes(IDENTITY_RESOLVE_SCOPE)) {
      await api("PATCH", `/client-grants/${grant.id}`, {
        scope: [...grantScopes, IDENTITY_RESOLVE_SCOPE],
      });
      out(`  ✓ patched client-grant ${grant.id} → + ${IDENTITY_RESOLVE_SCOPE}`);
    } else {
      out(`  · client-grant already has ${IDENTITY_RESOLVE_SCOPE} — no change`);
    }
  } else {
    const created = await api("POST", `/client-grants`, {
      client_id: M2M_CLIENT_ID,
      audience: CORE_API_AUDIENCE,
      scope: [IDENTITY_RESOLVE_SCOPE],
    });
    out(
      `  ✓ created client-grant ${created.id ?? "(id n/a)"} with ${IDENTITY_RESOLVE_SCOPE}`,
    );
  }
  return true;
}

// ── 3. Deploy the post-login Actions ─────────────────────────────────────────
//
// Auth0 builds an Action's draft ASYNCHRONOUSLY. CREATING an action and PATCHing
// its `code` (or its `secrets`) both kick off a fresh build; the action's
// `status` walks pending → building → built. POST /actions/actions/{id}/deploy
// returns 400 ("A draft must be in the 'built' state before it can be deployed")
// if it runs before that build finishes. The fix below waits for `built` before
// every deploy that follows a create/patch, so a fresh tenant (e.g. Genesis
// prod) configures fully in ONE run — no per-deploy retry to clear the 400.

// Alias of the `wait` helper defined with the HTTP client above (kept under the
// `sleep` name so the action-build poller below reads naturally).
const sleep = wait;

// Poll GET /actions/actions/{id} until its draft reports status === "built".
// Returns the action object once built. Throws on a terminal "failed" build or
// when the timeout elapses (≈60s: 30 polls × 2s) so the caller can decide
// required-vs-best-effort. `building`/`pending` (and any transient/unknown
// status) are treated as "still building" and re-polled. A freshly DEPLOYED
// action that is not re-edited stays "built", so re-runs return immediately.
async function waitForActionBuilt(id, name) {
  const POLL_MS = 2000;
  const MAX_POLLS = 30; // ≈60s
  let lastStatus = "";
  for (let i = 0; i < MAX_POLLS; i += 1) {
    const action = await api("GET", `/actions/actions/${id}`);
    const status = action?.status ?? "unknown";
    if (status === "built") {
      if (i > 0) out(`    ↳ "${name}" built (after ${i * POLL_MS}ms)`);
      return action;
    }
    if (status === "failed") {
      // Auth0 surfaces the build errors on the action; include them if present.
      const errs = Array.isArray(action?.errors)
        ? action.errors.map((e) => e?.message ?? JSON.stringify(e)).join("; ")
        : "";
      throw new Error(
        `action "${name}" build FAILED${errs ? `: ${errs}` : ""}`,
      );
    }
    if (status !== lastStatus) {
      out(`    ↳ waiting for "${name}" to build (status: ${status}) …`);
      lastStatus = status;
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `timed out after ${(MAX_POLLS * POLL_MS) / 1000}s waiting for action ` +
      `"${name}" to reach the 'built' state (last status: ${lastStatus || "unknown"})`,
  );
}

// Deploy an action safely: ALWAYS wait for the draft to reach `built` first,
// THEN POST /deploy. Auth0 builds asynchronously after a create or a code/secret
// PATCH, and /deploy 400s on a not-yet-built draft. We wait unconditionally
// (not just when we know we triggered a rebuild) so the deploy is also robust on
// a re-run that reconciles a PRIOR partial failure — e.g. a previous run created
// the action but its build was still in flight when the deploy 400'd; on re-run
// the code already matches (no fresh PATCH), yet the draft may still be building.
// waitForActionBuilt returns on the FIRST poll when the action is already built
// (one GET, no sleep), so this is cheap in the common steady-state path.
async function deployBuiltAction(id, name) {
  await waitForActionBuilt(id, name);
  await api("POST", `/actions/actions/${id}/deploy`);
}

async function listPostLoginActions() {
  // The list endpoint paginates; the Genesis tenant has a handful of actions so
  // a single page (per_page=100) is plenty, but page through to be safe.
  const all = [];
  let page = 0;
  for (;;) {
    const res = await api(
      "GET",
      `/actions/actions?triggerId=post-login&per_page=100&page=${page}`,
    );
    const batch = Array.isArray(res.actions) ? res.actions : [];
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return all;
}

// BEST-EFFORT. The post-login Actions are the login-flow glue (domain lock →
// role resolution → claim stamping). We try hard to create, build, deploy and
// (later) bind them, but a single Action's failure WARNS and CONTINUES rather
// than aborting the whole tenant setup (which would also strand the REQUIRED
// steps that already ran). Only the actions that deploy successfully are
// returned, and only those get bound — so a partial failure degrades cleanly,
// stays re-runnable, and is loudly visible in the run log instead of failing
// the ~1hr deploy. Each create / code-PATCH triggers an async Auth0 rebuild, so
// we wait for `built` before deploying (see deployBuiltAction / waitForActionBuilt).
async function deployActions() {
  out("\n▶ Post-login Actions (best-effort)");
  const existing = await listPostLoginActions();
  const byName = new Map(existing.map((a) => [a.name, a]));
  // Returns name → { id, display_name } for the binding step — ONLY for the
  // actions that actually deployed.
  const deployed = new Map();

  for (const { name, file } of ACTIONS) {
    let code;
    try {
      code = readFileSync(join(ACTIONS_DIR, file), "utf8");
    } catch (err) {
      // A missing/unreadable source is an operator/repo error, not a transient
      // Auth0 one — surface it loudly but keep going with the other actions.
      out(
        `  ✗ cannot read action source ${file}: ${err?.message ?? err} — skipping "${name}"`,
      );
      continue;
    }

    try {
      let action = byName.get(name);
      if (!action) {
        out(`  + creating missing action "${name}"`);
        action = await api("POST", `/actions/actions`, {
          name,
          code,
          supported_triggers: [{ id: "post-login", version: "v3" }],
          runtime: "node18",
        });
      } else if (action.code === code) {
        out(`  · "${name}" code already current (id=${action.id})`);
      } else {
        await api("PATCH", `/actions/actions/${action.id}`, { code });
        out(`  ✓ patched code for "${name}" (id=${action.id})`);
      }

      // Deploy is cheap + idempotent (publishes the current built draft as a new
      // deployed version); always deploy so a re-run after a code patch publishes
      // the new bytes. deployBuiltAction WAITS for the async build to reach
      // `built` first (Auth0 builds asynchronously) — otherwise /deploy 400s.
      await deployBuiltAction(action.id, name);
      out(`    ↳ deployed "${name}"`);

      deployed.set(name, {
        id: action.id,
        display_name: action.name ?? name,
      });
    } catch (err) {
      // Best-effort: log and continue. A later re-run reconciles (idempotent).
      out(
        `  ✗ failed to deploy action "${name}" (best-effort, continuing): ${
          err?.message ?? err
        }`,
      );
    }
  }
  return deployed;
}

// ── 3b. Instance domain-lock secret (OPT-IN, SECURITY-SENSITIVE) ─────────────
//
// Stamps the INSTANCE_EMAIL_DOMAIN secret onto the deployed "Instance Domain
// Lock" Action so the IdP enforces the single-customer email domain. This runs
// ONLY when the operator passes INSTANCE_EMAIL_DOMAIN in the env; otherwise the
// function is a no-op and the Action stays inert (allows all domains), which is
// the correct posture for shared staging.
//
// ⚠  CONSEQUENCE OF ENABLING: any user whose Auth0/Okta *profile* email domain
//    is not in INSTANCE_EMAIL_DOMAIN is denied at login across every connection.
//    Federated Okta testers authenticate with their real Okta email (which may
//    be a different domain than the @axiralabs.app HRD routing domain), so they
//    would be locked out until their Okta email is updated. Decide per env.
async function ensureInstanceDomainLockSecret(deployed) {
  if (INSTANCE_EMAIL_DOMAIN.length === 0) {
    out("\n▶ Instance domain-lock secret");
    out(
      "  · INSTANCE_EMAIL_DOMAIN unset — leaving the lock INERT (allows all " +
        "email domains). Set it ONLY for a single-tenant prod bring-up.",
    );
    return false;
  }

  out("\n▶ Instance domain-lock secret  ⚠  ENFORCEMENT ENABLED");
  out("  ┌─────────────────────────────────────────────────────────────────┐");
  out(`  │ Setting ${INSTANCE_EMAIL_DOMAIN_SECRET}=${INSTANCE_EMAIL_DOMAIN}`);
  out("  │ The IdP will now DENY sign-in for any email outside that domain,");
  out("  │ across ALL connections (Okta / OIDC / passwordless / …).");
  out("  │ Federated testers whose Okta profile email is a different domain");
  out("  │ WILL BE LOCKED OUT until their Okta email is changed.");
  out("  └─────────────────────────────────────────────────────────────────┘");

  const action = deployed.get(INSTANCE_DOMAIN_LOCK_ACTION);
  if (!action) {
    // The action's deploy is best-effort (deployActions warns + continues), so
    // it may be absent here. Don't abort the whole tenant setup — WARN loudly
    // (this is the security-sensitive lock the operator explicitly asked for)
    // and let a re-run reconcile once the action deploys.
    out(
      `  ✗ cannot set ${INSTANCE_EMAIL_DOMAIN_SECRET}: action ` +
        `"${INSTANCE_DOMAIN_LOCK_ACTION}" was not deployed this run. ` +
        `The domain-lock is NOT enforcing yet — re-run after the action deploys.`,
    );
    return false;
  }

  // Read current secrets; PATCH only when the value actually differs. Auth0
  // never returns secret VALUES (write-only), so we can't diff value-vs-value;
  // we PATCH the full secrets array idempotently (a re-PATCH of the same value
  // is harmless). The secrets PATCH triggers an async rebuild, so WAIT for
  // `built` before re-deploying — otherwise /deploy 400s — then deploy so the
  // new secret is live. Best-effort: a failure here warns + continues (the
  // domain isn't enforced until a clean re-run) rather than failing the deploy.
  try {
    await api("PATCH", `/actions/actions/${action.id}`, {
      secrets: [
        { name: INSTANCE_EMAIL_DOMAIN_SECRET, value: INSTANCE_EMAIL_DOMAIN },
      ],
    });
    await deployBuiltAction(action.id, INSTANCE_DOMAIN_LOCK_ACTION);
    out(`  ✓ secret set + re-deployed (id=${action.id})`);
    return true;
  } catch (err) {
    out(
      `  ✗ failed to set/deploy ${INSTANCE_EMAIL_DOMAIN_SECRET} ` +
        `(domain-lock NOT enforcing — re-run to reconcile): ${err?.message ?? err}`,
    );
    return false;
  }
}

// ── 4. Binding order ─────────────────────────────────────────────────────────
//
// Bind the post-login Actions in canonical order. Auth0 only lets a DEPLOYED
// action be bound, so we bind ONLY the actions that deployActions() actually
// deployed (present in `deployed`), preserving their canonical relative order.
// If a best-effort action failed to deploy, we skip it (loud warning) rather
// than aborting — the rest still bind, and a re-run reconciles the full order
// once that action deploys. Idempotent: PATCH only when the live order differs.
async function setBindingOrder(deployed) {
  out("\n▶ Post-login binding order");

  // Canonical order, filtered to the actions that deployed this run.
  const ordered = ACTIONS.filter(({ name }) => deployed.has(name));
  const missing = ACTIONS.filter(({ name }) => !deployed.has(name));
  for (const { name } of missing) {
    out(
      `  ✗ "${name}" did not deploy — excluding it from the binding order ` +
        `(re-run to reconcile once it deploys)`,
    );
  }
  if (ordered.length === 0) {
    out("  ✗ no actions deployed — nothing to bind (re-run to reconcile)");
    return false;
  }

  const bindings = ordered.map(({ name }) => {
    const a = deployed.get(name);
    return {
      ref: { type: "action_id", value: a.id },
      display_name: a.display_name,
    };
  });

  // Read current order; skip the PATCH if it already matches (idempotent).
  const cur = await api("GET", `/actions/triggers/post-login/bindings`);
  const curOrder = (Array.isArray(cur.bindings) ? cur.bindings : [])
    .map((b) => b?.action?.id)
    .filter(Boolean);
  const wantOrder = bindings.map((b) => b.ref.value);
  const same =
    curOrder.length === wantOrder.length &&
    curOrder.every((id, i) => id === wantOrder[i]);

  const label = ordered.map((a) => a.name).join(" → ");
  if (same) {
    out(`  · order already ${label} — no change`);
    return false;
  }

  await api("PATCH", `/actions/triggers/post-login/bindings`, { bindings });
  out(`  ✓ set order: ${label}`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  out(`▶ Auth0 tenant setup: ${DOMAIN}`);
  out(`  web app: ${WEB_APP_CLIENT_ID}`);

  MGMT_TOKEN = await mintMgmtToken();
  out("  ✓ Management API token minted");

  const webAppChanged = await ensureWebAppConfig();
  const emailConnChanged = await ensurePasswordlessEmailConnection();
  const resolveGrantSet = await ensureIdentityResolveGrant();
  const deployed = await deployActions();
  const lockSecretSet = await ensureInstanceDomainLockSecret(deployed);
  const orderChanged = await setBindingOrder(deployed);

  // Actions are best-effort: report which deployed and which didn't (a re-run
  // reconciles any that failed). The whole setup still exits 0 — the REQUIRED
  // steps (token, web-app, resource-server + identity:resolve grant) gate the
  // process via die() on their own failures.
  const deployedNames = ACTIONS.map((a) => a.name).filter((n) =>
    deployed.has(n),
  );
  const undeployedNames = ACTIONS.map((a) => a.name).filter(
    (n) => !deployed.has(n),
  );
  // Domain-lock posture: requested (INSTANCE_EMAIL_DOMAIN set) but the secret
  // didn't apply ⇒ flag it (NOT enforcing) distinctly from "inert (unset)".
  const lockRequested = INSTANCE_EMAIL_DOMAIN.length > 0;

  out("\n── Summary ─────────────────────────────────────────────");
  out(`  domain                 ${DOMAIN}`);
  out(`  web app (grant+RS256)  ${webAppChanged ? "PATCHED" : "already set"}`);
  out(
    `  passwordless email     ${
      emailConnChanged ? "PATCHED" : "already set"
    } (web app enabled on "${PASSWORDLESS_EMAIL_CONNECTION}")`,
  );
  out(
    `  identity:resolve grant  ${
      resolveGrantSet
        ? `ENSURED (m2m ${M2M_CLIENT_ID} → ${CORE_API_AUDIENCE})`
        : "SKIPPED (AUTH0_M2M_CLIENT_ID unset)"
    }`,
  );
  out(
    `  actions deployed        ${deployedNames.join(", ") || "(none)"}${
      undeployedNames.length > 0
        ? `   [NOT deployed: ${undeployedNames.join(", ")} — re-run to reconcile]`
        : ""
    }`,
  );
  out(
    `  instance domain-lock    ${
      lockSecretSet
        ? `ENFORCING (${INSTANCE_EMAIL_DOMAIN})`
        : lockRequested
          ? `REQUESTED but NOT enforcing (${INSTANCE_EMAIL_DOMAIN}) — re-run to reconcile`
          : "INERT (INSTANCE_EMAIL_DOMAIN unset)"
    }`,
  );
  out(`  binding order           ${orderChanged ? "PATCHED" : "already set"}`);
  out(
    `                          ${deployedNames.join(" → ") || "(none bound)"}`,
  );
  out("✓ Auth0 tenant setup complete (idempotent — safe to re-run).");
}

main().catch((err) => {
  die(err?.stack ?? err?.message ?? String(err));
});
