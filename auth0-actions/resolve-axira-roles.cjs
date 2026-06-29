/**
 * Auth0 Post-Login Action — Resolve Axira Roles ("Federated-Okta one login")
 *
 * Fires on every successful authentication on the Genesis Auth0 tenant.
 * For users coming through an Okta enterprise connection, it resolves the
 * user's Axira tenant + roles + portal_type and stamps them onto the issued
 * tokens — WITHOUT any inbound call to the (WARP-private) Axira gateway.
 *
 *   ┌─ No gateway call at login ─────────────────────────────────────────┐
 *   │ The Axira gateway is FULLY PRIVATE (Genesis requirement: no public  │
 *   │ APIs). So this Action makes NO inbound call at login. It reads two  │
 *   │ projections the platform maintains over the Auth0 Management API:   │
 *   │   • event.user.app_metadata   — per-user role projection (synced on │
 *   │                                  every provision/override/etc.).    │
 *   │   • event.connection.metadata — the tenant's role BASELINE, written │
 *   │                                  to the enterprise connection at    │
 *   │                                  wizard-complete. ALWAYS present on  │
 *   │                                  a federated login (unlike           │
 *   │                                  event.organization, which is absent │
 *   │                                  for app-level Okta connections      │
 *   │                                  invoked via ?connection=).          │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Why the connection-metadata baseline matters (the chicken-and-egg fix):
 *   A brand-new Okta user has NO app_metadata projection yet (the platform
 *   can't pre-write per-user metadata for a user who has never logged in and
 *   may not be in the directory). On a federated login event.organization is
 *   absent, and the gateway is private, so there is nowhere to read the
 *   tenant from. The connection metadata closes the loop: the platform writes
 *   the tenant baseline (tenant_id + default_role + group→role map) to the
 *   CONNECTION once, at wizard-complete (outbound, no per-user pre-write), and
 *   the FIRST user reads it here on login.
 *
 * Resolution (federated branch):
 *   tenant_id   = app_metadata.axira_tenant_id || connection.metadata.axira_tenant_id
 *   roles       = app_metadata.roles (if non-empty)             — override
 *               | mapGroupsToRoles(user.groups, conn.map)       — group match
 *               | [connection.metadata.axira_default_role]      — baseline
 *   portal_type = app_metadata.portal_type || connection.metadata.axira_portal_type
 *
 * Denials:
 *   • app_metadata.disabled === true  → deny (account disabled).
 *   • no tenant_id (neither source)   → deny ("not finished setting up" — the
 *                                        connection has no tenant baseline).
 *   • roles still empty AND the connection has NO axira_default_role baseline
 *                                     → deny ("not finished setting up" — the
 *                                        WIZARD GATE: the platform only writes
 *                                        default_role at wizard-complete, so a
 *                                        missing baseline means setup is not
 *                                        done. Stays SERVER-SIDE).
 *   • roles still empty WITH a baseline present (shouldn't happen, since the
 *                                        baseline would have become the role)
 *                                     → deny ("not provisioned").
 *
 * ── Behaviour matrix
 *
 *   Connection strategy is "auth0" (Username/Password DB):
 *     → SKIP. Native ops/admin users; "Set Axira Claims" stamps them.
 *
 *   Connection strategy is "email" (passwordless OTP):
 *     → SKIP. Borrower magic-link / first-admin bootstrap OTP; "Set Axira
 *       Claims" stamps these from org metadata + app_metadata.
 *
 *   Social/consumer strategies:
 *     → DENY unless SOCIAL_LOGIN_ENABLED secret is "true" (Okta-only
 *       enforcement, defense in depth). When explicitly enabled, SKIP (it
 *       has its own claim path).
 *
 *   Everything else (okta-workforce, oidc, samlp, ad, adfs, azuread, …):
 *     → resolve from connection.metadata + app_metadata, allow or deny.
 *
 * ── Secrets the Action needs
 *
 *   (none required for the federated read path — no gateway call, no M2M
 *    token). SOCIAL_LOGIN_ENABLED is the only optional secret, gating
 *    whether social strategies are denied at the IdP.
 */

const CLAIM_NAMESPACE = "https://axira.ai/";

// Social/consumer strategies. Axira is Okta-only; social login is DISABLED.
const SOCIAL_STRATEGIES = new Set([
  "google-oauth2",
  "github",
  "facebook",
  "linkedin",
  "twitter",
  "apple",
  "windowslive",
]);

/**
 * Map a user's IdP groups to Axira roles using the tenant's group→role map
 * carried in the connection metadata (a JSON string). Pure + synchronous —
 * NO network. Mirror of the gateway's resolveRolesFromIdpGroups:
 *   • The map is keyed by BOTH lowercased group NAME and lowercased Okta
 *     group id (00g…), because the customer's Okta may emit either in the
 *     groups claim.
 *   • Each group string is matched case-insensitively against the map keys.
 *   • Roles are de-duplicated, order-stable.
 *
 * @param {unknown} groups   event.user.groups (array of names and/or ids)
 * @param {unknown} mapJson  connection.metadata.axira_group_role_map (JSON string)
 * @returns {string[]} resolved Axira roles (possibly empty)
 */
function mapGroupsToRoles(groups, mapJson) {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  if (typeof mapJson !== "string" || mapJson.length === 0) return [];

  let map;
  try {
    map = JSON.parse(mapJson);
  } catch {
    return [];
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) return [];

  // Normalize map keys to lowercase once for case-insensitive lookup.
  const lowerMap = {};
  for (const k of Object.keys(map)) {
    if (typeof k === "string") lowerMap[k.toLowerCase()] = map[k];
  }

  const out = [];
  for (const g of groups) {
    if (typeof g !== "string" || g.length === 0) continue;
    const roles = lowerMap[g.toLowerCase()];
    if (!Array.isArray(roles)) continue;
    for (const r of roles) {
      if (typeof r === "string" && r.length > 0 && !out.includes(r)) {
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * @param {import('@auth0/auth0-actions-types').PostLoginEvent} event
 * @param {import('@auth0/auth0-actions-types').PostLoginAPI} api
 */
exports.onExecutePostLogin = async (event, api) => {
  const strategy = event.connection?.strategy ?? "";

  // Okta-only enforcement (Phase 4 / Chunk B), IdP-layer defense in depth.
  // Social login is DISABLED by default; deny the token unless the
  // SOCIAL_LOGIN_ENABLED secret is explicitly "true". KEEP the code: flip the
  // secret to re-enable. This refuses social at the IdP even if a social
  // connection is enabled on the tenant and a connection param slips through.
  if (SOCIAL_STRATEGIES.has(strategy)) {
    const socialEnabled = event.secrets?.SOCIAL_LOGIN_ENABLED === "true";
    if (!socialEnabled) {
      console.log(`[resolve-axira-roles] DENY social strategy=${strategy}`);
      api.access.deny("Social sign-in is not available for this workspace.");
      return;
    }
    // Social explicitly enabled: it has its own claim-stamping path, skip
    // resolve-roles (no provisioned_users binding for social identities).
    return;
  }

  // Skip strategies that have their own claim-stamping path:
  //   - "auth0": Username/Password DB; "Set Axira Claims" Action reads
  //     org_id from app_metadata and stamps claims for
  //     Universal-Login-with-Org and ROPG flows.
  //   - "email": passwordless email OTP (borrower magic-link /
  //     customer-central + first-admin bootstrap OTP). "Set Axira Claims"
  //     stamps these from org metadata + app_metadata. Resolve-roles MUST
  //     NOT run for them: the passwordless event has no provisioned_users
  //     binding to resolve, and `event.user.email` can be absent at this
  //     point in the flow.
  //
  // Everything else (okta-workforce, oidc, samlp, ad, adfs, azuread, etc.)
  // is an enterprise federation. An allowlist is wrong here because Auth0
  // keeps adding strategy strings; a denylist captures the intent (skip
  // native DB + passwordless; social is handled by the deny gate above).
  const skipStrategies = new Set(["auth0", "email"]);
  if (skipStrategies.has(strategy)) return;

  // Log the strategy for forensics — visible in Auth0 Real-time Webtask Logs.
  console.log(
    `[resolve-axira-roles] strategy=${strategy} connection=${event.connection?.name}`,
  );

  // ── Resolve from connection.metadata (tenant baseline) + app_metadata ────
  const connMeta =
    event.connection && typeof event.connection.metadata === "object"
      ? event.connection.metadata || {}
      : {};
  const appMeta =
    event.user && typeof event.user.app_metadata === "object"
      ? event.user.app_metadata || {}
      : {};

  // Deprovisioned / disabled in Axira: the platform set disabled=true (and
  // typically roles=[]) on the per-user app_metadata projection. Refuse.
  if (appMeta.disabled === true) {
    api.access.deny(
      "your Axira account is disabled — contact your admin to re-enable you",
    );
    return;
  }

  // Tenant: per-user projection wins; else the connection baseline. Absent
  // from BOTH means the connection has no tenant binding metadata at all —
  // the tenant has not been wired up yet.
  const tenantId = appMeta.axira_tenant_id || connMeta.axira_tenant_id;
  if (!tenantId) {
    api.access.deny(
      "your workspace is not finished setting up — ask your admin to complete Identity setup",
    );
    return;
  }

  // Roles precedence:
  //   1. app_metadata.roles (per-user override / projection) when non-empty.
  //   2. else group→role mapping from the connection's group_role_map.
  //   3. else the connection's default_role baseline.
  let roles = Array.isArray(appMeta.roles) ? appMeta.roles : [];
  if (roles.length === 0) {
    const mapped = mapGroupsToRoles(
      event.user?.groups,
      connMeta.axira_group_role_map,
    );
    if (mapped.length > 0) {
      roles = mapped;
    } else if (
      typeof connMeta.axira_default_role === "string" &&
      connMeta.axira_default_role.length > 0
    ) {
      roles = [connMeta.axira_default_role];
    }
  }

  if (roles.length === 0) {
    // WIZARD GATE (server-side): the platform writes axira_default_role to the
    // connection ONLY at wizard-complete. A missing baseline therefore means
    // the tenant has a connection (tenant_id present) but has NOT finished the
    // Identity wizard — deny "not finished setting up". With a baseline
    // present but roles still empty (shouldn't happen — the baseline would
    // have become the role), the user is simply not provisioned.
    const hasBaseline =
      typeof connMeta.axira_default_role === "string" &&
      connMeta.axira_default_role.length > 0;
    if (!hasBaseline) {
      api.access.deny(
        "your workspace is not finished setting up — ask your admin to complete Identity setup",
      );
    } else {
      api.access.deny(
        "not provisioned in Axira — ask your admin to provision you in Identity setup",
      );
    }
    return;
  }

  // portal_type: per-user projection wins; else the connection baseline.
  const portalType = appMeta.portal_type || connMeta.axira_portal_type;

  // ── Stamp the claims (allow) ────────────────────────────────────────────
  const aaid =
    typeof appMeta.aaid === "string" && appMeta.aaid.length > 0
      ? appMeta.aaid
      : undefined;

  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_id`, tenantId);
  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}roles`, roles);
  if (portalType) {
    api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}portal_type`, portalType);
  }
  if (aaid) {
    api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}aaid`, aaid);
  }
  // id_token mirrors what the SPA / BFF reads for display + middleware
  // tenant context.
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_id`, tenantId);
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}roles`, roles);
  if (portalType) {
    api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}portal_type`, portalType);
  }
  if (aaid) {
    api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}aaid`, aaid);
  }
};

// Exported for unit tests (node --test). Auth0 ignores extra exports.
exports.mapGroupsToRoles = mapGroupsToRoles;
