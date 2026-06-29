/**
 * Tenant Provisioning Workflow - Temporal durable workflow
 *
 * Orchestrates the complete 10-step tenant onboarding process.
 * Each step is idempotent and retryable (Temporal handles retries).
 */

import {
  proxyActivities,
  defineSignal,
  setHandler,
} from "@temporalio/workflow";

export interface TenantOnboarding {
  companyName: string;
  domain: string;
  adminEmail: string;
  products: string[];
  plan: "starter" | "professional" | "enterprise";
  hostingModel: "axira_hosted" | "customer_hosted";
  region: string;
}

export interface TenantProvisioningState {
  tenantId: string;
  status: "pending" | "provisioning" | "active" | "failed";
  currentStep: number;
  completedSteps: string[];
  error?: string;
}

// Signal to cancel provisioning
export const cancelProvisioningSignal = defineSignal("cancelProvisioning");

const activities = proxyActivities<{
  createTenantRecord(
    input: TenantOnboarding,
  ): Promise<{ id: string; slug: string }>;
  provisionAuth0(params: {
    orgName: string;
    domain: string;
    adminEmail: string;
    connections: string[];
  }): Promise<void>;
  deployCDKStack(
    stackName: string,
    params: { tenantId: string; hostingModel?: string },
  ): Promise<void>;
  generateCustomerDeploymentPackage(tenantId: string): Promise<void>;
  createTenantSchema(tenantId: string): Promise<void>;
  runMigrations(tenantId: string): Promise<void>;
  enableRLS(tenantId: string): Promise<void>;
  createS3Paths(tenantId: string): Promise<void>;
  registerEnvironments(
    tenantId: string,
    envs: { dev: string; staging: string; production: string },
  ): Promise<void>;
  installProduct(tenantId: string, productId: string): Promise<void>;
  createAdminUser(tenantId: string, email: string): Promise<void>;
  createDevBudget(
    tenantId: string,
    budget: { monthlyLimitUsd: number },
  ): Promise<void>;
  sendWelcomeEmail(
    email: string,
    urls: { loginUrl: string; studioUrl: string; documentationUrl: string },
  ): Promise<void>;
  updateTenantStatus(tenantId: string, status: string): Promise<void>;
}>({
  startToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
    maximumInterval: "5 minutes",
  },
});

export async function provisionTenant(
  input: TenantOnboarding,
): Promise<TenantProvisioningState> {
  let cancelled = false;
  setHandler(cancelProvisioningSignal, () => {
    cancelled = true;
  });

  const state: TenantProvisioningState = {
    tenantId: "",
    status: "provisioning",
    currentStep: 0,
    completedSteps: [],
  };

  try {
    // Step 1: Create tenant record in control plane database
    state.currentStep = 1;
    const tenant = await activities.createTenantRecord(input);
    state.tenantId = tenant.id;
    state.completedSteps.push("create-tenant-record");
    if (cancelled) return { ...state, status: "failed", error: "Cancelled" };

    // Step 2: Provision Auth0 organization
    state.currentStep = 2;
    await activities.provisionAuth0({
      orgName: input.companyName,
      domain: input.domain,
      adminEmail: input.adminEmail,
      connections: ["database"],
    });
    state.completedSteps.push("provision-auth0");
    if (cancelled) return { ...state, status: "failed", error: "Cancelled" };

    // Step 3: Provision infrastructure (environment-specific)
    state.currentStep = 3;
    if (input.hostingModel === "axira_hosted") {
      await activities.deployCDKStack("TenantDevStack", {
        tenantId: tenant.id,
        hostingModel: "dedicated",
      });
      await activities.deployCDKStack("TenantStagingStack", {
        tenantId: tenant.id,
      });
      await activities.deployCDKStack("TenantProductionStack", {
        tenantId: tenant.id,
      });
    } else {
      await activities.generateCustomerDeploymentPackage(tenant.id);
    }
    state.completedSteps.push("provision-infrastructure");
    if (cancelled) return { ...state, status: "failed", error: "Cancelled" };

    // Step 4: Create database schemas (RLS-isolated)
    state.currentStep = 4;
    await activities.createTenantSchema(tenant.id);
    await activities.runMigrations(tenant.id);
    await activities.enableRLS(tenant.id);
    state.completedSteps.push("create-database-schemas");

    // Step 5: Create S3 paths
    state.currentStep = 5;
    await activities.createS3Paths(tenant.id);
    state.completedSteps.push("create-s3-paths");

    // Step 6: Register environment URLs
    state.currentStep = 6;
    await activities.registerEnvironments(tenant.id, {
      dev: `https://dev.${tenant.slug}.axiralabs.ai`,
      staging: `https://staging.${tenant.slug}.axiralabs.ai`,
      production: `https://${tenant.slug}.axiralabs.ai`,
    });
    state.completedSteps.push("register-environments");

    // Step 7: Install default products
    state.currentStep = 7;
    for (const productId of input.products) {
      await activities.installProduct(tenant.id, productId);
    }
    state.completedSteps.push("install-products");

    // Step 8: Create admin user
    state.currentStep = 8;
    await activities.createAdminUser(tenant.id, input.adminEmail);
    state.completedSteps.push("create-admin-user");

    // Step 9: Set up dev budget
    state.currentStep = 9;
    await activities.createDevBudget(tenant.id, { monthlyLimitUsd: 500 });
    state.completedSteps.push("create-dev-budget");

    // Step 10: Send welcome email
    state.currentStep = 10;
    await activities.sendWelcomeEmail(input.adminEmail, {
      loginUrl: `https://${tenant.slug}.axiralabs.ai`,
      studioUrl: `https://${tenant.slug}.axiralabs.ai/studio`,
      documentationUrl: "https://docs.axiralabs.ai",
    });
    state.completedSteps.push("send-welcome-email");

    // Mark tenant as active
    await activities.updateTenantStatus(tenant.id, "active");
    state.status = "active";

    return state;
  } catch (err) {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    if (state.tenantId) {
      await activities.updateTenantStatus(
        state.tenantId,
        "provisioning_failed",
      );
    }
    throw err;
  }
}
