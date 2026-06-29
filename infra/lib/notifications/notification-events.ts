/**
 * Operational event type definitions for Slack/Teams notifications.
 */

export type OperationalEventType =
  | "deploy_started"
  | "deploy_succeeded"
  | "deploy_failed"
  | "deploy_rollback"
  | "canary_promoted"
  | "canary_rollback"
  | "accuracy_regression"
  | "certification_completed"
  | "certification_failed"
  | "release_available"
  | "release_hotfix"
  | "secret_rotation_completed"
  | "secret_rotation_failed"
  | "tenant_provisioned"
  | "subscription_past_due"
  | "subscription_suspended"
  | "feature_flag_changed";

export type Urgency = "info" | "warning" | "p2" | "p1";

export interface OperationalEvent {
  type: OperationalEventType;
  urgency: Urgency;
  timestamp: string;
  tenantId?: string;
  service?: string;
  version?: string;
  environment?: string;
  title: string;
  message: string;
  details?: Record<string, string>;
  actionUrl?: string;
  logsUrl?: string;
}

export interface TenantNotificationConfig {
  tenantId: string;
  provider: "slack" | "teams" | "both" | "none";
  slack?: {
    webhookUrl: string;
    channels: {
      deployments: string;
      incidents: string;
      releases: string;
      certifications: string;
    };
  };
  teams?: {
    webhookUrl: string;
    channels: {
      deployments: string;
      incidents: string;
      releases: string;
      certifications: string;
    };
  };
}

/** Map event types to Axira internal Slack channels */
export function getAxiraChannel(event: OperationalEvent): string {
  switch (event.type) {
    case "deploy_started":
    case "deploy_succeeded":
    case "deploy_failed":
    case "deploy_rollback":
    case "canary_promoted":
    case "canary_rollback":
      return "#axira-deployments";
    case "accuracy_regression":
    case "secret_rotation_failed":
    case "subscription_suspended":
      return "#axira-incidents";
    case "release_available":
    case "release_hotfix":
      return "#axira-releases";
    case "tenant_provisioned":
    case "subscription_past_due":
      return "#axira-tenants";
    default:
      return "#axira-deployments";
  }
}

/** Map event types to customer channel category */
export function getCustomerChannelCategory(
  event: OperationalEvent,
): "deployments" | "incidents" | "releases" | "certifications" {
  switch (event.type) {
    case "deploy_started":
    case "deploy_succeeded":
    case "deploy_failed":
    case "deploy_rollback":
    case "canary_promoted":
    case "canary_rollback":
    case "secret_rotation_completed":
    case "feature_flag_changed":
      return "deployments";
    case "accuracy_regression":
    case "secret_rotation_failed":
    case "subscription_suspended":
      return "incidents";
    case "release_available":
    case "release_hotfix":
      return "releases";
    case "certification_completed":
    case "certification_failed":
      return "certifications";
    default:
      return "deployments";
  }
}
