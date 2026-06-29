/**
 * Tenant Reactivation Workflow - Temporal durable workflow
 *
 * Removes all restrictions when payment succeeds.
 * - Remove read-only mode
 * - Unpause agents
 * - Unpause workflows
 * - Unblock SDK
 * - Remove warning banners
 */

import { proxyActivities } from "@temporalio/workflow";

export interface ReactivateInput {
  tenantId: string;
  reason: "payment_succeeded" | "manual";
}

const activities = proxyActivities<{
  setTenantReadOnlyMode(tenantId: string, readOnly: boolean): Promise<void>;
  unpauseTenantAgents(tenantId: string): Promise<void>;
  unpauseTenantWorkflowStarts(tenantId: string): Promise<void>;
  unblockTenantSDKOperations(tenantId: string): Promise<void>;
  disableTenantWarningBanner(tenantId: string): Promise<void>;
  updateTenantStatus(tenantId: string, status: string): Promise<void>;
  notifyTenantAdmin(
    tenantId: string,
    subject: string,
    message: string,
  ): Promise<void>;
  notifyAxiraInternal(
    event: string,
    tenantId: string,
    details: string,
  ): Promise<void>;
}>({
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

export async function reactivateTenant(input: ReactivateInput): Promise<void> {
  // Remove read-only mode
  await activities.setTenantReadOnlyMode(input.tenantId, false);

  // Unpause agents
  await activities.unpauseTenantAgents(input.tenantId);

  // Unpause workflows
  await activities.unpauseTenantWorkflowStarts(input.tenantId);

  // Unblock SDK
  await activities.unblockTenantSDKOperations(input.tenantId);

  // Remove warning banners
  await activities.disableTenantWarningBanner(input.tenantId);

  // Update tenant status
  await activities.updateTenantStatus(input.tenantId, "active");

  // Notify tenant admin
  await activities.notifyTenantAdmin(
    input.tenantId,
    "Account Reactivated",
    "Your Axira account has been reactivated. All services are now fully operational.",
  );

  // Notify Axira internal
  await activities.notifyAxiraInternal(
    "tenant_reactivated",
    input.tenantId,
    `Reason: ${input.reason}`,
  );
}
