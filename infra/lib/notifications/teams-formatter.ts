/**
 * Microsoft Teams Adaptive Card formatting for operational notifications.
 */

import type { OperationalEvent } from "./notification-events.js";

interface AdaptiveCard {
  type: string;
  attachments: Array<{
    contentType: string;
    content: {
      $schema: string;
      type: string;
      version: string;
      body: unknown[];
      actions?: unknown[];
    };
  }>;
}

const URGENCY_COLOR: Record<string, string> = {
  info: "good",
  warning: "warning",
  p2: "warning",
  p1: "attention",
};

export function formatTeamsMessage(event: OperationalEvent): AdaptiveCard {
  const color = URGENCY_COLOR[event.urgency] || "default";
  const body: unknown[] = [];

  // Title
  body.push({
    type: "TextBlock",
    size: "Large",
    weight: "Bolder",
    text: event.title,
    color,
  });

  // Facts
  const facts: Array<{ title: string; value: string }> = [];
  if (event.service) facts.push({ title: "Service", value: event.service });
  if (event.version) facts.push({ title: "Version", value: event.version });
  if (event.environment)
    facts.push({ title: "Environment", value: event.environment });
  facts.push({ title: "Time", value: event.timestamp });

  if (event.details) {
    for (const [key, value] of Object.entries(event.details)) {
      facts.push({ title: key, value });
    }
  }

  if (facts.length > 0) {
    body.push({ type: "FactSet", facts });
  }

  // Message
  if (event.message) {
    body.push({
      type: "TextBlock",
      text: event.message,
      wrap: true,
    });
  }

  // Actions
  const actions: unknown[] = [];
  if (event.actionUrl) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View Details",
      url: event.actionUrl,
    });
  }
  if (event.logsUrl) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View Logs",
      url: event.logsUrl,
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}
