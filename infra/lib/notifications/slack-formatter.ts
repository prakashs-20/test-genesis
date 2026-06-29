/**
 * Slack Block Kit message formatting for operational notifications.
 */

import type { OperationalEvent } from "./notification-events.js";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<{
    type: string;
    text: { type: string; text: string };
    url?: string;
    style?: string;
  }>;
}

const URGENCY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  p2: "🟠",
  p1: "🔴",
};

export function formatSlackMessage(event: OperationalEvent): {
  blocks: SlackBlock[];
} {
  const emoji = URGENCY_EMOJI[event.urgency] || "ℹ️";
  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `${emoji} ${event.title}`, emoji: true },
  });

  // Fields
  const fields: Array<{ type: string; text: string }> = [];
  if (event.service)
    fields.push({ type: "mrkdwn", text: `*Service:* ${event.service}` });
  if (event.version)
    fields.push({ type: "mrkdwn", text: `*Version:* ${event.version}` });
  if (event.environment)
    fields.push({
      type: "mrkdwn",
      text: `*Environment:* ${event.environment}`,
    });
  fields.push({ type: "mrkdwn", text: `*Time:* ${event.timestamp}` });

  if (event.details) {
    for (const [key, value] of Object.entries(event.details)) {
      fields.push({ type: "mrkdwn", text: `*${key}:* ${value}` });
    }
  }

  if (fields.length > 0) {
    blocks.push({ type: "section", fields });
  }

  // Message body
  if (event.message) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: event.message },
    });
  }

  // Action buttons
  const actions: SlackBlock["elements"] = [];
  if (event.actionUrl) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "View Details" },
      url: event.actionUrl,
    });
  }
  if (event.logsUrl) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "View Logs" },
      url: event.logsUrl,
    });
  }
  if (actions.length > 0) {
    blocks.push({ type: "actions", elements: actions });
  }

  return { blocks };
}
