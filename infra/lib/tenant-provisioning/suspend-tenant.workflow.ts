/**
 * Tenant Suspension Workflow - Temporal durable workflow
 *
 * Applies read-only restrictions when subscription lapses.
 * - Set read-only mode
 * - Pause all agents
 * - Pause workflow starts (running ones complete)
 * - Block SDK operations (axira dev/publish/deploy)
 * - Show warning banners in UI
 */

import { proxyActivities } from "@temporalio/workflow";

export interface SuspendInput {
  tenantId: string;
  reason: "payment_failed" | "manual" | "compliance";
}

const activities = proxyActivities<{
  setTenantReadOnlyMode(tenantId: string, readOnly: boolean): Promise<void>;
  pauseTenantAgents(tenantId: string): Promise<void>;
  pauseTenantWorkflowStarts(tenantId: string): Promise<void>;
  blockTenantSDKOperations(tenantId: string): Promise<void>;
  enableTenantWarningBanner(tenantId: string, message: string): Promise<void>;
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

export async function suspendTenant(input: SuspendInput): Promise<void> {
  // Set read-only mode
  await activities.setTenantReadOnlyMode(input.tenantId, true);

  // Pause all agents (no new agent tasks accepted)
  await activities.pauseTenantAgents(input.tenantId);

  // Pause workflow starts (running workflows complete, no new ones)
  await activities.pauseTenantWorkflowStarts(input.tenantId);

  // Block SDK operations
  await activities.blockTenantSDKOperations(input.tenantId);

  // Show warning banner in UI
  await activities.enableTenantWarningBanner(
    input.tenantId,
    "Account suspended. Contact support to reactivate.",
  );

  // Update tenant status
  await activities.updateTenantStatus(input.tenantId, "suspended");

  // Notify tenant admin
  await activities.notifyTenantAdmin(
    input.tenantId,
    "Account Suspended",
    "Your Axira account has been suspended due to payment issues. Please update your billing to restore access.",
  );

  // Notify Axira internal
  await activities.notifyAxiraInternal(
    "tenant_suspended",
    input.tenantId,
    `Reason: ${input.reason}`,
  );
}
