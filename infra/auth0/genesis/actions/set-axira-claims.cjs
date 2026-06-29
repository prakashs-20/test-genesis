/**
 * Auth0 Post-Login Action: Set Axira Claims (canonical, de-Genesis)
 *
 * Stamps the Axira-namespaced JWT claims for the login flows that
 * `resolve-axira-roles.cjs` deliberately SKIPS:
 *   - "auth0": Username/Password DB users (Universal-Login-with-Org AND the
 *     custom ROPG password-realm grant).
 *   - passwordless: borrower magic-link (customer-central) + first-admin
 *     bootstrap email OTP.
 *
 * It is the IdP-layer claim source for those flows; federated/Okta logins
 * are resolved server-side by "Resolve Axira Roles" instead.
 *
 * ── DE-GENESIS (Phase 4 / A5) ────────────────────────────────────────
 *   This is the GENERAL replacement for the previously-deployed
 *   "Set Axira Claims" Action, which HARDCODED `@genesiscapital.com` →
 *   a fixed org_id (org_1MiDRaX…) → a fixed tenant_id (2358f0d0…) →
 *   products:["lending"]. None of that is here. Everything is resolved
 *   from per-deployment, per-tenant sources:
 *     • tenant_id   ← org.metadata.axira_tenant_id, else org.id
 *     • org_id      ← event.organization.id
 *     • roles       ← Auth0 Org role assignments, else app_metadata.roles
 *     • portal_type ← app_metadata.portal_type (borrowers set "customer")
 *     • products    ← org.metadata.products (JSON), else the
 *                     AXIRA_DEFAULT_PRODUCTS secret (JSON or CSV), else [].
 *                     NEVER a hardcoded product id literal.
 *
 *   A clean deployment that has not set AXIRA_DEFAULT_PRODUCTS and whose
 *   orgs carry no `products` metadata stamps an EMPTY products claim
 *   (fail-safe-not-Genesis); the gateway then resolves product access from
 *   the tenant_products table rather than a token default.
 *
 * ── Login-flow order ─────────────────────────────────────────────────
 *   instance-domain-lock  →  resolve-axira-roles  →  THIS ACTION
 *   (the lock rejects wrong-domain identities first; resolve-axira-roles
 *   handles federated logins; this handles DB + passwordless.)
 *
 * ── Optional secret (Action secrets vault) ───────────────────────────
 *   AXIRA_DEFAULT_PRODUCTS  per-deployment licensed product ids the DB /
 *                           passwordless flows should carry when the org
 *                           has no `products` metadata. JSON array
 *                           (e.g. ["lending"]) or a comma-separated list
 *                           (e.g. "lending,compliance"). Unset => [].
 */

const CLAIM_NAMESPACE = "https://axira.ai/";

// Strategies whose claims are stamped by "Resolve Axira Roles" (federated)
// rather than this Action. Mirrors the denylist intent there.
const FEDERATED_STRATEGIES_HANDLED_ELSEWHERE = new Set([
  "google-oauth2",
  "github",
  "facebook",
  "linkedin",
  "twitter",
  "apple",
  "windowslive",
]);

/**
 * Resolve the products claim from per-deployment / per-tenant sources only.
 * @param {import('@auth0/auth0-actions-types').PostLoginEvent} event
 * @returns {string[]}
 */
function resolveProducts(event) {
  const org = event.organization;
  // 1) Per-tenant org metadata (JSON array string).
  const orgProducts = org?.metadata?.products;
  if (typeof orgProducts === "string" && orgProducts.length > 0) {
    try {
      const parsed = JSON.parse(orgProducts);
      if (Array.isArray(parsed)) {
        return parsed.filter((p) => typeof p === "string");
      }
    } catch {
      /* fall through to the deployment default */
    }
  }
  // 2) Per-deployment secret (JSON array OR comma-separated list).
  const raw = event.secrets?.AXIRA_DEFAULT_PRODUCTS;
  if (typeof raw === "string" && raw.trim().length > 0) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((p) => typeof p === "string");
        }
      } catch {
        /* fall through to CSV parse */
      }
    }
    return trimmed
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }
  // 3) De-Genesis default: NO hardcoded product. Empty => the gateway
  //    resolves product access from tenant_products.
  return [];
}

/**
 * @param {import('@auth0/auth0-actions-types').PostLoginEvent} event
 * @param {import('@auth0/auth0-actions-types').PostLoginAPI} api
 */
exports.onExecutePostLogin = async (event, api) => {
  const strategy = event.connection?.strategy ?? "";
  // Federated logins are claim-stamped by "Resolve Axira Roles".
  if (FEDERATED_STRATEGIES_HANDLED_ELSEWHERE.has(strategy)) return;

  const org = event.organization;
  const appMeta =
    event.user && typeof event.user.app_metadata === "object"
      ? event.user.app_metadata
      : {};

  // ── Tenant id ── org metadata (org-scoped login) first; else the user's
  // app_metadata. The first-admin passwordless OTP grant does NOT reliably
  // surface `event.organization` to this Action, so without this fallback the
  // founding workspace-admin gets a CLAIM-LESS token and the Admin Hub
  // rejects them ("Admin access required"). app_metadata.axira_tenant_id +
  // app_metadata.roles are written at provisioning, so they are the correct
  // source when the org context is missing.
  const tenantId =
    (org && (org.metadata?.axira_tenant_id ?? org.id)) ||
    (typeof appMeta.axira_tenant_id === "string"
      ? appMeta.axira_tenant_id
      : undefined);
  // Without any tenant context there is nothing to scope — skip.
  if (!tenantId) return;
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_id`, tenantId);
  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_id`, tenantId);

  // ── Tenant name ── org display_name, else app_metadata.org_display_name.
  const tenantName =
    (org && org.display_name) ||
    (typeof appMeta.org_display_name === "string"
      ? appMeta.org_display_name
      : undefined);
  if (tenantName) {
    api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_name`, tenantName);
    api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}tenant_name`, tenantName);
  }

  // ── AAID (platform member UUID) ── from app_metadata, else Auth0 sub.
  const aaid = event.user.app_metadata?.aaid ?? event.user.user_id;
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}aaid`, aaid);
  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}aaid`, aaid);

  // ── Roles ── Auth0 Org role assignments first (staff provisioning),
  // else app_metadata.roles (borrower signup / seeds), else empty.
  const orgRoles = Array.isArray(event.authorization?.roles)
    ? event.authorization.roles
    : [];
  const metadataRoles = Array.isArray(event.user.app_metadata?.roles)
    ? event.user.app_metadata.roles.filter((r) => typeof r === "string")
    : [];
  const roles = orgRoles.length > 0 ? orgRoles : metadataRoles;
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}roles`, roles);
  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}roles`, roles);

  // ── Portal type ── "customer" for borrowers; absent for staff.
  const portalType = event.user.app_metadata?.portal_type;
  if (typeof portalType === "string" && portalType.length > 0) {
    api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}portal_type`, portalType);
    api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}portal_type`, portalType);
  }

  // ── Portal entity id (borrowers only) ──
  const portalEntityId = event.user.app_metadata?.portal_entity_id;
  if (typeof portalEntityId === "string" && portalEntityId.length > 0) {
    api.idToken.setCustomClaim(
      `${CLAIM_NAMESPACE}portal_entity_id`,
      portalEntityId,
    );
    api.accessToken.setCustomClaim(
      `${CLAIM_NAMESPACE}portal_entity_id`,
      portalEntityId,
    );
  }

  // ── Products ── per-tenant / per-deployment only; never a literal.
  const products = resolveProducts(event);
  api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}products`, products);
  api.accessToken.setCustomClaim(`${CLAIM_NAMESPACE}products`, products);

  // ── Email domain ──
  if (typeof event.user.email === "string" && event.user.email.includes("@")) {
    const domain = event.user.email.split("@")[1];
    api.idToken.setCustomClaim(`${CLAIM_NAMESPACE}email_domain`, domain);
  }
};

// Exported for unit testing.
exports.__internal__ = { resolveProducts };
