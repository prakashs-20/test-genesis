// SLO target, SLI definitions, and burn-rate alarm math.

import type { ServiceName, SloConfig } from "./config.js";

export type SliId =
  | "conversation-first-paint"
  | "conversation-end-to-end"
  | "deal-progress";

export interface SliDef {
  readonly id: SliId;
  readonly description: string;
  readonly thresholdMs: (slo: SloConfig) => number;
  readonly service: ServiceName;
  readonly logGroupSuffix: string;
  readonly filterPattern: string;
  readonly metricName: string;
}

export const SLIS: readonly SliDef[] = [
  {
    id: "conversation-first-paint",
    description:
      "Time from client request to first byte of streamed agent response",
    thresholdMs: (slo) => slo.conversationFirstPaintMs,
    service: "axira-gateway",
    logGroupSuffix: "axira-gateway",
    filterPattern:
      '{ $.message = "request_completed" && $.path = "/v1/runtime/agents*" && $.status < 400 }',
    metricName: "sli/conversation-first-paint/latency-ms",
  },
  {
    id: "conversation-end-to-end",
    description: "Wall-clock duration of POST /v1/runtime/conversation/turn",
    thresholdMs: (slo) => slo.conversationEndToEndMs,
    service: "axira-gateway",
    logGroupSuffix: "axira-gateway",
    filterPattern:
      '{ $.message = "request_completed" && $.path = "/v1/runtime/conversation/turn*" && $.status < 400 }',
    metricName: "sli/conversation-end-to-end/latency-ms",
  },
  {
    id: "deal-progress",
    description: "Realtime read latency on /v1/lending/deals/* endpoints",
    thresholdMs: (slo) => slo.dealProgressMs,
    service: "axira-gateway",
    logGroupSuffix: "axira-gateway",
    filterPattern:
      '{ $.message = "request_completed" && $.path = "/v1/lending/deals*" && $.status < 400 }',
    metricName: "sli/deal-progress/latency-ms",
  },
];

export function errorBudgetMinutesPerMonth(slo: SloConfig): number {
  return Math.round((1 - slo.availabilityTarget) * 30 * 24 * 60 * 100) / 100;
}

export interface BurnRateAlarm {
  readonly id: string;
  readonly windowMinutes: number;
  readonly burnRate: number;
  readonly description: string;
}

export function burnRateAlarms(slo: SloConfig): readonly BurnRateAlarm[] {
  return [
    {
      id: "fast",
      windowMinutes: slo.fastBurnWindowMinutes,
      burnRate:
        (slo.fastBurnPctOfBudget * 30 * 24) / (slo.fastBurnWindowMinutes / 60),
      description: `Burned ${slo.fastBurnPctOfBudget}% of monthly budget in ${slo.fastBurnWindowMinutes} minutes`,
    },
    {
      id: "slow",
      windowMinutes: slo.slowBurnWindowMinutes,
      burnRate:
        (slo.slowBurnPctOfBudget * 30 * 24) / (slo.slowBurnWindowMinutes / 60),
      description: `Burned ${slo.slowBurnPctOfBudget}% of monthly budget in ${slo.slowBurnWindowMinutes} minutes`,
    },
  ];
}
