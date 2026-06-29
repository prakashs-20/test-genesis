# Auth0 IaC - `axiralabs-internal` tenant

Infrastructure-as-Code for the `axiralabs-internal` Auth0 tenant. This tenant gates `apps/axira-ops-console` and the admin endpoints of `apps/ops-plane-receiver`. It is for Axira-internal operators only - customers do not have accounts here.

## Workflow

1. **Tenant creation is ClickOps.** Vignesh creates the tenant once via the Auth0 UI on the Developer plan. See `docs/ai-context/playbooks/onboard-axira-ops.md` (Steps 1 and 2). The YAML files in this directory cannot exist before the tenant does - they hold Auth0-issued IDs (client IDs, connection IDs, role IDs, action IDs) that only get assigned once the tenant is created.

2. **Initial export populates the YAMLs.** Once the tenant exists and is configured per `tenant-spec.md`, run:

   ```
   npx auth0-deploy-cli@8 export \
     --config_file infra/auth0/axiralabs-internal/config.json \
     --format yaml \
     --output_folder infra/auth0/axiralabs-internal/
   ```

   The export produces `tenant.yaml`, `clients.yaml`, `connections.yaml`, `roles.yaml`, and `actions.yaml`. Commit the result.

3. **Subsequent changes flow through PRs.** After the initial export, edit the YAMLs as part of a normal PR. The `.github/workflows/auth0-deploy.yml` workflow validates the changes in `--pretend` mode on PRs and applies them on merge to `main`.

4. **Never edit Auth0 settings in the UI after the export.** The export is authoritative. Manual UI changes drift from the YAMLs and the next `apply` run reverses them - losing the manual change. If you need to change a setting, edit the YAML, open a PR, let the workflow apply on merge.

## Files

| File               | Owner            | Purpose                                                             |
| ------------------ | ---------------- | ------------------------------------------------------------------- |
| `README.md`        | Engineering      | This file.                                                          |
| `tenant-spec.md`   | Engineering      | Declarative source-of-truth for what the tenant should contain.     |
| `config.json`      | Engineering      | `auth0-deploy-cli` configuration; placeholders resolved at CI time. |
| `tenant.yaml`      | auth0-deploy-cli | Tenant-level settings. Populated by export.                         |
| `clients.yaml`     | auth0-deploy-cli | Application registrations. Populated by export.                     |
| `connections.yaml` | auth0-deploy-cli | Identity provider connections. Populated by export.                 |
| `roles.yaml`       | auth0-deploy-cli | Role definitions. Populated by export.                              |
| `actions.yaml`     | auth0-deploy-cli | Auth0 Actions (post-login flow). Populated by export.               |
| `.gitignore`       | Engineering      | Excludes local overrides and CLI backups.                           |

`connections.yaml`, `roles.yaml`, and `actions.yaml` do not exist in this directory yet - they are produced by the first `auth0-deploy-cli export` after the tenant is configured.

## Related

- `docs/ai-context/playbooks/onboard-axira-ops.md` - first-time setup runbook (Vignesh executes outside Claude sessions).
- `docs/ai-context/decisions/0002-skip-grafana-for-now.md` - context for why a custom console exists and why this tenant is needed.
- `infra/auth0/axiralabs-internal/tenant-spec.md` - the prescriptive spec Vignesh follows during ClickOps.
