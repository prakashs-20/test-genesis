# Genesis Auth0 — Actions

Source for the Post-Login Actions deployed to the **Genesis** Auth0 tenant
(the customer-facing tenant used by `apps/admin-hub` and `apps/experience`).

The files here are checked in for review + versioning. Auth0 itself runs
them inside its own sandbox — there is no "deploy from this repo" pipeline
yet. The operator playbook in
[`docs/playbooks/auth0-okta-federation.md`](../../../../docs/playbooks/auth0-okta-federation.md)
walks through pasting the source into the Auth0 dashboard.

## Files

| File                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance-domain-lock.cjs`     | **Run FIRST.** Per-deployment instance domain-lock — denies any email whose domain != `INSTANCE_EMAIL_DOMAIN` (Action secret), across all strategies. Not deployed yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `resolve-axira-roles.cjs`      | **Federated-Okta one login**: resolves the user's Axira tenant + roles + portal_type from `event.connection.metadata` (the tenant BASELINE) + `event.user.app_metadata` (the per-user projection) and stamps the claims onto tokens (federated / Okta logins). Makes NO inbound call to the (private) gateway. The platform writes the per-user projection on every provision/override (gateway Auth0-sync worker, app_metadata) AND the tenant baseline to the enterprise CONNECTION metadata at wizard-complete (`sync-connection` job) — so a brand-new Okta user's FIRST login resolves from `event.connection.metadata` with NO per-user pre-write. `event.connection.metadata` is always present on a federated login (unlike `event.organization`). |
| `resolve-axira-roles.test.cjs` | Node-native unit test (`node --test ...`). 12 scenarios (app_metadata override, connection default_role baseline, group→role map, override precedence, disabled, no-tenant, the server-side wizard gate, native/passwordless/social skips, `mapGroupsToRoles` unit cases) — each with a no-fetch guard asserting the gateway is never called. (Run this FILE directly; running the whole directory picks up the non-test `.cjs` and reports a spurious dir-level fail.)                                                                                                                                                                                                                                                                                    |
| `set-axira-claims.cjs`         | **General (de-Genesis) claim-stamping** for DB + passwordless logins. Resolves tenant/org/roles/products from org metadata + app_metadata + `AXIRA_DEFAULT_PRODUCTS`; NO `@genesiscapital.com` / fixed-org / `["lending"]` literal. Supersedes `scripts/auth0-post-login-action.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `set-axira-claims.test.cjs`    | Node-native unit test for the products resolution (`node --test ...`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

> **Login-flow order:** `instance-domain-lock` → `resolve-axira-roles`
> (federated) → `set-axira-claims` (DB + passwordless). The lock must reject a
> wrong-domain identity before any tenant is resolved. `set-axira-claims.cjs` is
> the Phase-4 de-Genesis replacement for the live "Set Axira Claims" Action that
> hardcoded `@genesiscapital.com`; the deploy step is to paste it over that
> Action in the dashboard.

Run the tests (per FILE — a whole-directory run treats the non-test `.cjs`
sources as empty test files and reports a spurious directory-level fail):

```bash
node --test infra/auth0/genesis/actions/resolve-axira-roles.test.cjs
node --test infra/auth0/genesis/actions/set-axira-claims.test.cjs
```

## Why `.cjs`?

Auth0's Actions runtime is CommonJS — actions are `exports.onExecutePostLogin = ...`.
This monorepo's `infra/package.json` declares `"type": "module"`, so we use
the `.cjs` extension to force CommonJS resolution under Node tests.
