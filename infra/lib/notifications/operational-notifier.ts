/**
 * Operational Notifier - dispatches events to Slack and/or Teams.
 *
 * Two notification targets:
 * - Axira internal: always Slack (#deployments, #incidents, #releases, #tenants)
 * - Customer: Slack OR Teams, configurable per tenant
 */

import { formatSlackMessage } from "./slack-formatter.js";
import { formatTeamsMessage } from "./teams-formatter.js";
import {
  getAxiraChannel,
  getCustomerChannelCategory,
  type OperationalEvent,
  type TenantNotificationConfig,
} from "./notification-events.js";

interface TenantConfigRepository {
  getNotificationConfig(
    tenantId: string,
  ): Promise<TenantNotificationConfig | null>;
}

export class OperationalNotifier {
  constructor(
    private readonly axiraSlackWebhook: string,
    private readonly tenantConfigRepo: TenantConfigRepository,
  ) {}

  async notify(event: OperationalEvent): Promise<void> {
    // 1. Always notify Axira internal Slack
    const axiraChannel = getAxiraChannel(event);
    await this.sendToSlack(this.axiraSlackWebhook, event, axiraChannel);

    // For P1 events, also send to #axira-incidents if not already the target
    if (event.urgency === "p1" && axiraChannel !== "#axira-incidents") {
      await this.sendToSlack(this.axiraSlackWebhook, event, "#axira-incidents");
    }

    // 2. Notify customer (if configured and event has a tenantId)
    if (event.tenantId) {
      const config = await this.tenantConfigRepo.getNotificationConfig(
        event.tenantId,
      );
      if (!config || config.provider === "none") return;

      const channelCategory = getCustomerChannelCategory(event);

      if (config.provider === "slack" || config.provider === "both") {
        if (config.slack) {
          const channel = config.slack.channels[channelCategory];
          await this.sendToSlack(config.slack.webhookUrl, event, channel);
        }
      }

      if (config.provider === "teams" || config.provider === "both") {
        if (config.teams) {
          const channel = config.teams.channels[channelCategory];
          await this.sendToTeams(config.teams.webhookUrl, event, channel);
        }
      }
    }
  }

  private async sendToSlack(
    webhookUrl: string,
    event: OperationalEvent,
    _channel: string,
  ): Promise<void> {
    const payload = formatSlackMessage(event);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `Slack notification failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  private async sendToTeams(
    webhookUrl: string,
    event: OperationalEvent,
    _channel: string,
  ): Promise<void> {
    const payload = formatTeamsMessage(event);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(
        `Teams notification failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
