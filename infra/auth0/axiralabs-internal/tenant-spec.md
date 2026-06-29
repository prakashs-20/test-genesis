# Tenant Spec - `axiralabs-internal`

Declarative specification of what should exist in the `axiralabs-internal` Auth0 tenant. This is the prescriptive source-of-truth that Vignesh follows when configuring the tenant via ClickOps for the first time (per `docs/ai-context/playbooks/onboard-axira-ops.md` Step 2). Once `auth0-deploy-cli export` runs against the configured tenant, the YAML files in this directory become the operational source-of-truth and this document becomes the design reference.

## Tenant settings

| Setting                     | Value                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| Tenant name                 | `axiralabs-internal`                                                   |
| Region                      | US                                                                     |
| Plan                        | Developer (free)                                                       |
| Default URL                 | `axiralabs-internal.us.auth0.com` (no custom domain - see ADR 0002)    |
| Multi-Factor Authentication | Required tenant-wide (Always)                                          |
| Session lifetime (idle)     | 8 hours sliding                                                        |
| Session lifetime (absolute) | 24 hours                                                               |
| Refresh token rotation      | Enabled (rotate on use; reuse interval 30 seconds)                     |
| Brute-force protection      | Enabled                                                                |
| Bot detection               | Enabled (Adaptive MFA off - Developer plan limit; revisit if upgraded) |
| Log retention               | 30 days (Developer plan ceiling)                                       |
| Long-term log archive       | Deferred - Phase 5.5 will add a weekly S3 export job                   |

## Connections

One connection only:

- **Google (social)** - single-sign-on via Google Workspace.
  - Sync user profile: enabled
  - Email domain restriction: enforced through the post-login Action below (the connection itself does not filter by domain - the Action does).
  - Connection name: `google-oauth2` (Auth0 default for the Google social connection).

No database connection. No other social connections. No enterprise connections.

## Roles

Three roles, with permission scopes drawn from the application logic, not from Auth0-side relationships. Auth0 does not natively model role hierarchy; the implementation-side permission matrix in `apps/axira-ops-console` enforces `admin ⊃ sre ⊃ employee`.

| Role             | Description                                                                                                             | Auth0 permissions (none - handled app-side) |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `axira-employee` | Default for any newly-provisioned `@axiralabs.ai` user. Read-only access to the fleet view in `apps/axira-ops-console`. | -                                           |
| `axira-sre`      | Adds: acknowledge alerts, view support-access sessions, trigger HMAC key rotation, view audit logs.                     | -                                           |
| `axira-admin`    | Adds: create / suspend customers, assign roles, configure tenant-level settings in the console, full audit-log access.  | -                                           |

Roles are assigned manually in the Auth0 UI on first issuance and via the Management API thereafter. The console reads role membership from the `https://axira.ai/internal_roles` claim populated by the post-login Action.

## Applications

Two applications:

### Application 1 - "Axira Ops Console"

| Property               | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Type                   | Regular Web Application                                                         |
| Allowed Callback URLs  | `http://localhost:3010/api/auth/callback` (production URL added in Session 5.5) |
| Allowed Logout URLs    | `http://localhost:3010` (production URL added in Session 5.5)                   |
| Allowed Web Origins    | `http://localhost:3010` (production URL added in Session 5.5)                   |
| Token Endpoint Auth    | `client_secret_post`                                                            |
| Grant Types            | `authorization_code`, `refresh_token`                                           |
| Refresh Token Rotation | Enabled                                                                         |
| Audience               | `https://console.axiralabs.ai` (logical; matches the value the console expects) |

### Application 2 - "Axira Deploy CLI"

| Property          | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Type              | Machine-to-Machine                                                                        |
| Audience          | Auth0 Management API (`https://<tenant>.us.auth0.com/api/v2/`)                            |
| Authorized scopes | `read:*`, `update:*`, `create:*`, `delete:*` for the following resource types:            |
|                   | `clients`, `clients_keys`, `connections`, `users`, `roles`, `actions`, `tenant_settings`, |
|                   | `email_templates`, `branding`, `rules`, `rules_configs`, `prompts`                        |
| Grant Types       | `client_credentials`                                                                      |

The Deploy CLI client ID + secret are stored in GitHub repository secrets (see `docs/ai-context/playbooks/onboard-axira-ops.md` Step 3) so the `.github/workflows/auth0-deploy.yml` workflow can authenticate.

## Actions

One Action only:

### `restrict-to-axiralabs-domain`

- **Trigger:** Login / Post Login flow.
- **Status:** Published (not draft) and bound to the live Post Login flow.
- **Runtime:** Node 22.
- **Behavior:** If the authenticated user's email does not end with `@axiralabs.ai`, deny access:

  ```javascript
  exports.onExecutePostLogin = async (event, api) => {
    const email = event.user.email || "";
    if (!email.toLowerCase().endsWith("@axiralabs.ai")) {
      api.access.deny(
        "This Auth0 tenant is restricted to axiralabs.ai accounts.",
      );
      return;
    }
    api.idToken.setCustomClaim(
      "https://axira.ai/internal_roles",
      (event.authorization?.roles || []).filter((r) => r.startsWith("axira-")),
    );
  };
  ```

- **Secrets:** None.
- **Dependencies:** None.

The Action both enforces the domain restriction and emits the `internal_roles` custom claim that the console reads to derive `axira-employee` / `axira-sre` / `axira-admin` membership.

## What this document does NOT contain

- It does not contain Auth0-issued IDs (client IDs, connection IDs, role IDs, action IDs). Those are produced when the tenant is created and live in the exported YAML files.
- It does not contain secrets (M2M client secret, signing keys). Those live in GitHub repository secrets per the runbook.
- It does not contain production callback URLs. Those are added in Session 5.5 when `apps/axira-ops-console` deploys to `console.axiralabs.ai`.
- It does not enforce a role hierarchy at the Auth0 level. Permission composition is the application's responsibility.

## Open questions

- **Adaptive MFA.** Requires a paid plan tier. Revisit if Auth0 pricing or our threat model changes.
- **Audit-log export to S3.** Auth0's Log Streams to AWS EventBridge is the cleanest path; needs an Axira-ops AWS-side EventBridge → Kinesis Firehose → S3 pipeline. Deferred to Session 5.5.
- **Universal Login customization.** The default Universal Login screen will show `axiralabs-internal.us.auth0.com`. Acceptable for internal use; an internal-tenant brand pass can land any time without operational urgency.
