# Genesis Production Deployment Guide

This guide walks you through deploying the Axira lending platform (axira-los) in your own AWS account. Follow the steps in order. Your platform engineer should be able to complete the first deployment to staging in about half a day, most of which is the one-time AWS and GitHub setup.

How it works: you provide an AWS account and a GitHub repository, supply a small set of values, and run a workflow. The pipeline performs the deployment end to end. You do not edit application code, run any CDK commands by hand, or change anything in production manually.

You deploy two environments from the same tooling, in the same AWS account. Deploy staging first, confirm it works, then deploy production.

| Environment | Application URL | Deploy first? |
|---|---|---|
| genesis-prod-staging | axira-los-staging.genesiscapital.com | Yes, start here |
| genesis-prod | axira-los.genesiscapital.com | After staging is confirmed |

Throughout this guide, `<ENV>` means either `GENESIS_PROD` (production) or `GENESIS_PROD_STAGING` (staging). Replace the placeholders in angle brackets (for example `<account-id>`, `<region>`, `<your-org>`) with your own values.

---

## Overview: the steps

1. Confirm what you received and review the bundle.
2. Create the GitHub repository and push the bundle.
3. Build the AWS foundation.
4. Configure the GitHub Environments.
5. Auth0 (configured by Axira, no action needed).
6. Verify the images.
7. Deploy to staging and watch it.
8. Confirm staging access.
9. Deploy to production.
10. Future releases.

---

## Step 1: Confirm what you received

You should have received the following from Axira. Confirm you have all of them before beginning.

1. This guide.
2. The deployment bundle (`genesis-los-handover.zip`).
3. The JFrog pull token (`genesis-readonly`), to pull the container images.
4. The cosign public key (`cosign.pub`), to verify the images.
5. The two Auth0 secret values, one per environment.
6. Confirmation that the release images (for example `v1.0.0-rc1`) are available in your JFrog.

### What is in the bundle

Unzip `genesis-los-handover.zip`. It contains:

| Item | What it is | Where you use it |
|---|---|---|
| `.github/workflows/` | The deployment pipeline (three workflows) | Step 2: push to your repo. Steps 7 and 9: run it. |
| `infra/` | The CDK infrastructure code | The pipeline runs this. You do not edit or run it. |
| `scripts/` | Helper scripts the pipeline calls | Used automatically by the pipeline. |
| `auth0-actions/` | Auth0 configuration code | Axira installs this in the shared tenant. |
| `README.md` | A short reference | Optional reading. |

The three workflows in `.github/workflows/` are:

```
deploy-genesis-production.yml      production deployment (Environment genesis-prod)
deploy-genesis-staging.yml         staging deployment (Environment genesis-prod-staging)
_deploy-genesis-standalone.yml     the shared workflow the two run
```

---

## Step 2: Create the GitHub repository and pipeline

The deployment runs as GitHub Actions in a repository you control. Nothing runs on a local machine.

1. Create a new private GitHub repository.
2. Unzip the bundle and push its full contents to that repository, using the commands below.
3. On GitHub, open the repository's Actions tab. The three deploy workflows are now listed.
4. Go to Settings, then Environments, and create two environments named exactly `genesis-prod` and `genesis-prod-staging`. You add secrets and variables to them in Step 4.

Commands for step 2:

```
unzip genesis-los-handover.zip
cd genesis-los-handover
git init
git branch -M main
git add .
git commit -m "axira-los deployment tooling"
git remote add origin git@github.com:<your-org>/<your-repo>.git
git push -u origin main
```

---

## Step 3: Build the AWS foundation

Create the following in your AWS account, once. These are the parts the pipeline cannot create for itself. The deployment creates everything else (network, load balancer, services, database, caches, and stores) in Step 7.

### 3.1 Deployment role (GitHub OIDC)

Create an IAM role that your GitHub workflows assume. If you have not used GitHub OIDC in this account before, first add the identity provider `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`) under IAM, Identity providers.

Give the role this trust policy, pointing at your repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<your-org>/<your-repo>:*" }
      }
    }
  ]
}
```

Grant the role permissions for CloudFormation, ECS, ECR, EC2, KMS (describe), Secrets Manager, and STS. Note the role ARN. You store it as a GitHub secret in Step 4.

### 3.2 CDK bootstrap

Run this once for the account and region, using AWS credentials for that account:

```
cdk bootstrap aws://<account-id>/<region>
```

This creates only the CDK toolkit (a staging bucket and supporting roles). It does not create any platform resources.

### 3.3 TLS certificate

Request an ACM certificate in the deploy region covering the apex and wildcard hostnames, validated through your Route 53:

```
aws acm request-certificate \
  --region <region> \
  --domain-name axira-los.genesiscapital.com \
  --subject-alternative-names "*.axira-los.genesiscapital.com" \
  --validation-method DNS
```

Add the validation records in Route 53 (the console offers a one-click option). Once the certificate shows as Issued, note its ARN. Repeat for the staging hostnames if you use a separate certificate.

### 3.4 VPN access

The application load balancer is internal and is not reachable from the public internet. Set up VPN access from your network to the deploy VPC, and note the CIDR ranges that should be allowed to reach the load balancer. The deployment opens the load balancer only to these ranges. You provide the CIDRs now; the VPC itself is created by the deployment, so you connect the VPN to it around the first deploy.

### 3.5 DNS hosted zone

Confirm you own a Route 53 hosted zone for the environment hostnames. After the deployment you point your records at the load balancer it outputs (Step 7).

### 3.6 Bedrock model access

In the deploy region, enable Amazon Bedrock model access for Anthropic Claude. The platform calls the model through IAM, so there is no API key to manage.

### 3.7 Outbound access

Two sets of endpoints need to be reachable.

From the deployment VPC (the running platform):

1. The Auth0 tenant for this environment: `axiralabs-prod.us.auth0.com` for genesis-prod, or `axiralabs.us.auth0.com` for genesis-prod-staging. The platform validates sign-in tokens and creates the first administrator through it, so sign-in fails without this.
2. The Axira operations receiver for this environment: `https://ops.axiralabs.ai/v1/events` for genesis-prod, or `https://ops-staging.axiralabs.ai/v1/events` for genesis-prod-staging.
3. AWS service APIs (ECR, Secrets Manager, Bedrock, and others), over their VPC endpoints or your NAT gateway. The container images are pulled from your in-account ECR, so the image pull stays inside AWS.

From the GitHub Actions runner and your engineer's workstation:

1. `axiralabs.jfrog.io`, to pull and verify the images. During the deploy the runner mirrors the images from JFrog into your ECR, so the VPC itself never pulls from JFrog.

---

## Step 4: Configure the GitHub Environments

On each of the two GitHub Environments from Step 2, add the following.

Secrets:

1. `AWS_DEPLOY_ROLE`: the deployment role ARN from Step 3.1.
2. `GENESIS_PROD_SECRETS_JSON` (on genesis-prod) or `GENESIS_STAGING_SECRETS_JSON` (on genesis-prod-staging): the Auth0 value Axira supplied.
3. `JFROG_USER` and `JFROG_TOKEN`: the read-only pull credentials Axira supplied.

Variables:

1. `CDK_<ENV>_ACCOUNT`: the AWS account id.
2. `CDK_<ENV>_REGION`: the deploy region.
3. `CDK_<ENV>_ALB_CERT_ARN`: the certificate ARN from Step 3.3.
4. `CDK_<ENV>_VPN_CIDRS`: the CIDR ranges from Step 3.4.
5. `CDK_<ENV>_WILDCARD_CERT_ARN` (optional): a separate certificate for the admin hostname, if used.

The Auth0 secret is a single JSON value with this shape. Axira provides the values; you paste it in as the secret.

```json
{
  "auth0":      { "domain": "...", "clientId": "...", "clientSecret": "...", "auth0Secret": "...", "issuerBaseUrl": "..." },
  "auth0-m2m":  { "clientId": "...", "clientSecret": "..." },
  "auth0-mgmt": { "clientId": "...", "clientSecret": "..." }
}
```

You do not provide database, LLM, or authorization-store credentials. The deployment generates the database credentials (Amazon Aurora in your account), uses Bedrock through IAM for the LLM, and provisions the authorization store automatically.

---

## Step 5: Auth0 (configured by Axira, no action needed)

Auth0 runs on shared Axira tenants that Axira manages. Your hostnames are already known (the URLs in the environment table), so Axira configures the Auth0 applications for them during onboarding. You do not send anything or take any action in this step. Your only Auth0 task was storing the secret value in Step 4. If first sign-in does not work, confirm with Axira that the Auth0 setup for your hostnames is complete.

---

## Step 6: Verify the images

Sign in to the registry with the pull token, then verify each image signature. cosign v3 is required.

```
docker login axiralabs.jfrog.io
```

```
cosign verify \
  --key cosign.pub \
  --insecure-ignore-tlog=true \
  axiralabs.jfrog.io/axira-images/axira-gateway:v1.0.0-rc1
```

Repeat the verify for each of the six images: `axira-gateway`, `axira-experience`, `axira-admin-hub`, `axira-agent-runtime`, `axira-workflow-engine`, and `axira-observability-alert-runner`.

---

## Step 7: Deploy to staging and watch it

### Start the deployment

In your repository, open the Actions tab, select `deploy-genesis-staging.yml`, and choose Run workflow. Enter the release tag (for example `v1.0.0-rc1`) and start it.

### Watch it

The first deployment takes about 20 to 30 minutes. You can watch it in two places.

In GitHub Actions, open the running workflow. It moves through these stages in order, and each turns green as it finishes:

```
1. Verify images
2. Bootstrap
3. Seed secrets
4. Database migrations
5. Deploy infrastructure (the longest stage)
6. Configure Auth0
7. Roll services
8. Smoke test
```

In the AWS console (optional, to watch the resources appear):

1. CloudFormation: the stacks move from CREATE_IN_PROGRESS to CREATE_COMPLETE. The first deployment creates several stacks for the network, data, compute, and observability layers.
2. ECS: open the cluster, then Services. Each of the six services starts tasks and settles on a steady running count once healthy.

A healthy result is every GitHub Actions stage green, all CloudFormation stacks CREATE_COMPLETE, and all six ECS services running. If a stage fails, the GitHub Actions log shows the error. The pipeline is safe to re-run.

### Point DNS at the load balancer

When the workflow finishes, it outputs a load balancer DNS name as `AlbDnsName` (visible in the run summary and as a CloudFormation output). In your Route 53 hosted zone, create alias records for the application and admin hostnames pointing at that name. Use an alias to the output, not a copied IP address, because the address changes when the load balancer scales.

---

## Step 8: Confirm staging access

1. Connect to the VPN that reaches the deploy VPC. The load balancer is internal, so you cannot reach it without the VPN.
2. Open the staging application URL in a browser: `https://axira-los-staging.genesiscapital.com`.
3. Sign in. The first administrator signs in with a one-time code sent by email. Enter the administrator email, receive the code, and enter it.
4. Confirm the dashboard loads.
5. Open the admin console at `https://admin.axira-los-staging.genesiscapital.com` and confirm it loads.

If a URL does not resolve, confirm your Route 53 alias points at the `AlbDnsName` output and that you are connected to the VPN.

---

## Step 9: Deploy to production

Repeat Steps 6 through 8 for production:

1. Verify the images (Step 6).
2. In the Actions tab, run `deploy-genesis-production.yml` with the same release tag, and watch it as in Step 7.
3. Point your production Route 53 records at the `AlbDnsName` output.
4. Confirm access at `https://axira-los.genesiscapital.com` and `https://admin.axira-los.genesiscapital.com` (Step 8).

---

## Step 10: Future releases

For each new release, Axira publishes new images to your JFrog and gives you the new release tag. To deploy it:

1. Verify the new images (Step 6).
2. Run the deploy workflow for the environment with the new release tag.
3. Confirm access.

The one-time setup in Steps 2 through 5 does not need to be repeated.

---

## Environment reference

| Setting | genesis-prod | genesis-prod-staging |
|---|---|---|
| Application URL | axira-los.genesiscapital.com | axira-los-staging.genesiscapital.com |
| Admin URL | admin.axira-los.genesiscapital.com | admin.axira-los-staging.genesiscapital.com |
| GitHub Environment | genesis-prod | genesis-prod-staging |
| Variable prefix | `CDK_GENESIS_PROD_` | `CDK_GENESIS_PROD_STAGING_` |
| Auth0 secret | `GENESIS_PROD_SECRETS_JSON` | `GENESIS_STAGING_SECRETS_JSON` |
| Deploy workflow | `deploy-genesis-production.yml` | `deploy-genesis-staging.yml` |
| Network | VPN-private, internal load balancer | VPN-private, internal load balancer |
| Ops receiver | `https://ops.axiralabs.ai` | `https://ops-staging.axiralabs.ai` |
| Auth0 tenant | `axiralabs-prod.us.auth0.com` | `axiralabs.us.auth0.com` |

---

## Support

For deployment questions or issues, contact your Axira delivery team. The platform is operated through the pipeline. If any step appears to need a manual change in production, report it to Axira so it can be corrected in the pipeline rather than applied by hand.
