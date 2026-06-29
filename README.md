# Genesis Production Deployment Bundle

This bundle is the deployment tooling for running the Axira lending platform (axira-los) in Genesis's own AWS account. It contains the CDK infrastructure and the GitHub Actions deploy workflows only. It contains no Axira application source (no apps, no packages, no monorepo). The platform runs from cosign-signed container images that Axira publishes to your JFrog registry; this bundle never builds them.

## Start here

Open **GENESIS-PROD-HANDOVER.md**. It is the step-by-step deployment guide: what to set up in AWS and GitHub, how to deploy, how to watch the deployment, and how to confirm access. Follow it in order.

## What is in this bundle

```
genesis-los-handover/
├── README.md                          this file
├── GENESIS-PROD-HANDOVER.md           the step-by-step deployment guide (start here)
├── infra/                             the CDK app (standalone, no monorepo)
│   ├── package.json, package-lock.json, cdk.json
│   └── bin/  lib/  auth0/  scripts/   CDK stacks and configuration
├── .github/workflows/
│   ├── deploy-genesis-production.yml  production deploy (run from the Actions tab)
│   ├── deploy-genesis-staging.yml     staging deploy
│   └── _deploy-genesis-standalone.yml the shared workflow the two callers run
├── scripts/
│   └── setup-auth0-tenant.mjs         Auth0 tenant configuration (used by the pipeline)
└── auth0-actions/                     the post-login Auth0 Action snippets
```

Both environments (genesis-prod and genesis-prod-staging) deploy from this one bundle into the same Genesis AWS account. Database migrations are baked into the gateway image and run by the pipeline, so no SQL ships in this bundle.

## How you deploy

The deployment runs as GitHub Actions. You put this bundle in a private GitHub repository, complete the one-time AWS and GitHub setup, and run the workflow for the target environment. GENESIS-PROD-HANDOVER.md has the full steps. A manual `cdk deploy` path is also possible for advanced operators (the CDK app is in `infra/`), but the GitHub Actions path is recommended.

## Verifying an image (cosign v3)

```
cosign verify --key cosign.pub --insecure-ignore-tlog=true \
  axiralabs.jfrog.io/axira-images/axira-gateway:v1.0.0-rc1
```

Verify the tag (index) digest, not a per-arch manifest digest. `--insecure-ignore-tlog=true` is expected (Axira-managed key, no public transparency log).

## Support

Axira support: support@axiralabs.ai. The deploy pipeline is fully automated. If any step appears to need a manual change in production, report it to Axira so it can be fixed in the pipeline rather than applied by hand.
