/**
 * Auth0 Post-Login Action — Instance Domain-Lock (Phase 1)
 *
 * DEPLOYMENT MODEL
 *   Axira ships INSIDE one customer's environment, dedicated to ONE
 *   customer, at a subdomain of that customer's domain. The deployment
 *   serves ONLY the customer's EMAIL domain (e.g. genesiscapital.com).
 *
 * WHAT THIS ACTION DOES
 *   Denies sign-in for ANY user whose email domain is not the instance
 *   domain, across ALL connection strategies (database, okta-workforce,
 *   oidc, samlp, social, passwordless, …). This is the IdP-layer twin of
 *   the gateway + Experience instance domain-lock (INSTANCE_EMAIL_DOMAIN):
 *     • Experience login form        — pre-submit UX guard
 *     • /api/auth/* (BFF)            — server-side session reject
 *     • gateway resolve-idp          — method:"domain_rejected"
 *     • gateway ProvisionByDomain    — status:"domain_rejected"
 *     • THIS ACTION                  — refuse the token at the IdP
 *
 *   It must run FIRST in the Login flow, BEFORE the role-resolution /
 *   claim-stamping Actions ("Resolve Axira Roles", "Set Axira Claims"),
 *   so a wrong-domain identity never even reaches role resolution.
 *
 * ── Secret the Action needs (Action secrets vault) ───────────────────
 *
 *   INSTANCE_EMAIL_DOMAIN   the customer's email domain. Case-
 *                           insensitive; a comma-separated list is
 *                           allowed for a multi-brand customer
 *                           (e.g. "genesiscapital.com,genesiscapitalre.com").
 *
 *   If the secret is unset/empty the Action is INERT (allows everyone) —
 *   matching the gateway/Experience helper's "no lock configured"
 *   behaviour. Production deployments MUST set this secret.
 *
 * ── IMPORTANT: DO NOT DEPLOY YET ─────────────────────────────────────
 *
 *   NOTE: This source is checked in for review + versioning only. It is
 *   NOT wired into Auth0 yet. Auth0 runs Actions inside its own sandbox;
 *   there is no deploy-from-repo pipeline. Pasting it into the dashboard
 *   + ordering it first in the Login flow is a deploy-time step.
 *
 *   NOTE (Phase 4 / A5 — de-Genesis): the GENERAL claim-stamping Action
 *   source now lives at `set-axira-claims.cjs` in this directory. It reads
 *   tenant/org/roles/products from per-tenant org metadata + app_metadata
 *   (NO @genesiscapital.com / org_1MiDRaX… / 2358f0d0… literal). The
 *   deploy step is to PASTE that source over the currently-deployed
 *   "Set Axira Claims" Action so the live Action stops hardcoding Genesis.
 *   This Action's INSTANCE_EMAIL_DOMAIN secret is the single source of the
 *   served domain.
 */

/**
 * Parse a comma-separated INSTANCE_EMAIL_DOMAIN into a lowercased list.
 * Tolerates surrounding whitespace and a leading "@".
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseInstanceDomains(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
}

/**
 * @param {import('@auth0/auth0-actions-types').PostLoginEvent} event
 * @param {import('@auth0/auth0-actions-types').PostLoginAPI} api
 */
exports.onExecutePostLogin = async (event, api) => {
  const allowed = parseInstanceDomains(event.secrets.INSTANCE_EMAIL_DOMAIN);

  // No lock configured → inert (allow everyone). Keeps a misconfigured /
  // not-yet-configured deployment from locking everyone out, and matches
  // the gateway/Experience helper semantics.
  if (allowed.length === 0) {
    console.log(
      "[instance-domain-lock] INSTANCE_EMAIL_DOMAIN unset — lock inert",
    );
    return;
  }

  const email = typeof event.user.email === "string" ? event.user.email : "";
  const at = email.lastIndexOf("@");
  const domain = at >= 0 ? email.slice(at + 1).toLowerCase() : "";

  if (domain.length === 0 || !allowed.includes(domain)) {
    console.log(
      `[instance-domain-lock] DENY email_domain=${domain || "<none>"} not in [${allowed.join(",")}]`,
    );
    // Human-readable message — surfaces on the Experience /signin-error
    // page (the [...auth0] callback wrapper maps Auth0's
    // error_description into the page).
    api.access.deny("This workspace isn't available for that email account.");
    return;
  }

  console.log(`[instance-domain-lock] ALLOW email_domain=${domain}`);
};
