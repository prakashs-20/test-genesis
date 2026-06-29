/**
 * Tenant Deprovisioning Workflow - Temporal durable workflow
 *
 * Orchestrates complete data cleanup after 30-day grace period.
 * Each step is idempotent - safe to retry on failure.
 * Audit log is retained for 7 years (regulatory requirement).
 */

import { proxyActivities, sleep } from "@temporalio/workflow";

export interface DeprovisionInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  hostingModel: "axira_hosted" | "customer_hosted";
  gracePeriodDays: number;
}

const activities = proxyActivities<{
  verifyGracePeriodElapsed(
    tenantId: string,
    gracePeriodDays: number,
  ): Promise<boolean>;
  exportTenantData(
    tenantId: string,
  ): Promise<{ exported: boolean; downloadUrl?: string }>;
  deleteTenantPostgresData(tenantId: string): Promise<void>;
  deleteTenantS3Objects(tenantId: string): Promise<void>;
  deleteTenantOpenSearchIndices(tenantId: string): Promise<void>;
  deleteTenantRedisKeys(tenantId: string): Promise<void>;
  deleteTenantTemporalNamespaces(tenantId: string): Promise<void>;
  deleteTenantAuth0Organization(tenantId: string): Promise<void>;
  removeTenantDnsRecords(tenantId: string): Promise<void>;
  destroyTenantCDKStacks(tenantId: string): Promise<void>;
  removeTenantFromControlPlane(tenantId: string): Promise<void>;
  sendDeprovisionConfirmationEmail(
    email: string,
    tenantName: string,
  ): Promise<void>;
  retainAnonymizedAuditLog(
    tenantId: string,
    tenantName: string,
    retentionYears: number,
  ): Promise<void>;
  updateTenantStatus(tenantId: string, status: string): Promise<void>;
}>({
  startToCloseTimeout: "30 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
    maximumInterval: "10 minutes",
  },
});

export async function deprovisionTenant(
  input: DeprovisionInput,
): Promise<void> {
  // Step 1: Verify grace period has elapsed
  const elapsed = await activities.verifyGracePeriodElapsed(
    input.tenantId,
    input.gracePeriodDays,
  );
  if (!elapsed) {
    // Grace period not yet elapsed - wait and check again
    await sleep(`${input.gracePeriodDays} days`);
    const elapsedNow = await activities.verifyGracePeriodElapsed(
      input.tenantId,
      input.gracePeriodDays,
    );
    if (!elapsedNow) {
      throw new Error("Grace period verification failed after waiting");
    }
  }

  // Step 2: Export data (if not already downloaded)
  await activities.exportTenantData(input.tenantId);

  // Step 3: Delete PostgreSQL data (CASCADE on tenant_id)
  await activities.deleteTenantPostgresData(input.tenantId);

  // Step 4: Delete S3 objects ({tenantId}/ prefix)
  await activities.deleteTenantS3Objects(input.tenantId);

  // Step 5: Delete OpenSearch indices
  await activities.deleteTenantOpenSearchIndices(input.tenantId);

  // Step 6: Delete Redis keys
  await activities.deleteTenantRedisKeys(input.tenantId);

  // Step 7: Delete Temporal namespaces
  await activities.deleteTenantTemporalNamespaces(input.tenantId);

  // Step 8: Delete Auth0 organization
  await activities.deleteTenantAuth0Organization(input.tenantId);

  // Step 9: Remove DNS records
  await activities.removeTenantDnsRecords(input.tenantId);

  // Step 10: Destroy CDK stacks (if dedicated hosting)
  if (input.hostingModel === "axira_hosted") {
    await activities.destroyTenantCDKStacks(input.tenantId);
  }

  // Step 11: Remove from control plane
  await activities.removeTenantFromControlPlane(input.tenantId);

  // Step 12: Send confirmation email
  await activities.sendDeprovisionConfirmationEmail(
    input.adminEmail,
    input.tenantName,
  );

  // Step 13: Retain anonymized audit log (7 years)
  await activities.retainAnonymizedAuditLog(
    input.tenantId,
    input.tenantName,
    7,
  );
}
