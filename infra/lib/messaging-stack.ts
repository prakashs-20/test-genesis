import * as cdk from "aws-cdk-lib";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

// ─── Per-Domain SNS Topics ──────────────────────────────────────────────────
// Keep in sync with infra/scripts/localstack-init.sh

const TOPIC_NAMES = [
  // Core business domains
  "axira-events-deal",
  "axira-events-document",
  "axira-events-agent",
  "axira-events-mission",
  "axira-events-approval",
  "axira-events-loan",
  // Platform domains
  "axira-events-knowledge",
  "axira-events-evidence",
  "axira-events-platform",
  "axira-events-orchestration",
  // Lending lifecycle domains
  "axira-events-case",
  "axira-events-compliance",
  "axira-events-intake",
  "axira-events-investigation",
  "axira-events-monitoring",
  "axira-events-screening",
  "axira-events-sar",
  // Feature flags — user-profile cache refresh (Lane C)
  "axira-events-user-profile",
] as const;

// ─── Subscription Matrix ────────────────────────────────────────────────────
// Keep in sync with infra/scripts/localstack-init.sh

const CONSUMERS: readonly { name: string; subscribesTo: readonly string[] }[] =
  [
    {
      name: "projection-consumer",
      subscribesTo: [
        "axira-events-deal",
        "axira-events-document",
        "axira-events-agent",
        "axira-events-loan",
        "axira-events-knowledge",
        "axira-events-evidence",
        "axira-events-platform",
        "axira-events-orchestration",
        "axira-events-case",
        "axira-events-intake",
        "axira-events-investigation",
        "axira-events-monitoring",
      ],
    },
    {
      name: "projection-consumer-priority",
      subscribesTo: ["axira-events-approval", "axira-events-mission"],
    },
    {
      name: "search-indexer",
      subscribesTo: [
        "axira-events-deal",
        "axira-events-document",
        "axira-events-loan",
        "axira-events-knowledge",
        "axira-events-case",
      ],
    },
    {
      name: "notification-dispatcher",
      subscribesTo: [
        "axira-events-approval",
        "axira-events-mission",
        "axira-events-loan",
        "axira-events-case",
        "axira-events-monitoring",
      ],
    },
    {
      name: "compliance-monitor",
      subscribesTo: [
        "axira-events-deal",
        "axira-events-document",
        "axira-events-approval",
        "axira-events-loan",
        "axira-events-compliance",
        "axira-events-screening",
        "axira-events-sar",
        "axira-events-investigation",
      ],
    },
    {
      name: "agui-streamer",
      subscribesTo: [
        "axira-events-agent",
        "axira-events-mission",
        "axira-events-orchestration",
      ],
    },
    {
      name: "workflow-trigger",
      subscribesTo: [
        "axira-events-deal",
        "axira-events-mission",
        "axira-events-approval",
        "axira-events-orchestration",
      ],
    },
    {
      name: "webhook-dispatcher",
      // Subscribes to ALL topics - tenant-configurable webhooks can fire on any event
      subscribesTo: TOPIC_NAMES,
    },
    {
      // Async user-profile cache refresh (Lane C). The refresh Lambda is the
      // SQS trigger; it consumes cache-evicted events and rebuilds the profile.
      name: "user-profile-cache-refresh",
      subscribesTo: ["axira-events-user-profile"],
    },
  ];

export class MessagingStack extends cdk.Stack {
  public readonly topics: Record<string, sns.Topic>;
  public readonly queues: Record<string, sqs.Queue>;
  public readonly dlqs: Record<string, sqs.Queue>;

  /**
   * Full ARN prefix for per-domain topic routing.
   * e.g. "arn:aws:sns:us-west-2:123456789:axira-events"
   * Application code appends "-{domain}" to get the topic ARN.
   */
  public readonly topicPrefix: string;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    const topicProps = config.messaging.useFifo
      ? { fifo: true, contentBasedDeduplication: true }
      : {};

    // ── SNS Topics (per-domain) ──
    this.topics = {};
    for (const name of TOPIC_NAMES) {
      const topicName = config.messaging.useFifo ? `${name}.fifo` : name;
      this.topics[name] = new sns.Topic(this, name, {
        topicName,
        ...topicProps,
      });
    }

    this.topicPrefix = `arn:aws:sns:${config.region}:${config.account}:axira-events`;

    // ── SQS Queues + DLQs ──
    this.queues = {};
    this.dlqs = {};

    for (const consumer of CONSUMERS) {
      const dlq = new sqs.Queue(this, `${consumer.name}-dlq`, {
        queueName: config.messaging.useFifo
          ? `${consumer.name}-dlq.fifo`
          : `${consumer.name}-dlq`,
        retentionPeriod: cdk.Duration.days(14),
        ...(config.messaging.useFifo ? { fifo: true } : {}),
      });
      this.dlqs[consumer.name] = dlq;

      const queue = new sqs.Queue(this, consumer.name, {
        queueName: config.messaging.useFifo
          ? `${consumer.name}.fifo`
          : consumer.name,
        visibilityTimeout: cdk.Duration.seconds(
          config.messaging.visibilityTimeout,
        ),
        retentionPeriod: cdk.Duration.seconds(
          config.messaging.messageRetention,
        ),
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: config.messaging.dlqMaxReceiveCount,
        },
        ...(config.messaging.useFifo
          ? { fifo: true, contentBasedDeduplication: true }
          : {}),
      });

      // Subscribe queue to its topics
      for (const topicName of consumer.subscribesTo) {
        this.topics[topicName].addSubscription(
          new subs.SqsSubscription(queue, { rawMessageDelivery: true }),
        );
      }

      this.queues[consumer.name] = queue;
    }

    // ── Outputs ──
    new cdk.CfnOutput(this, "TopicPrefix", {
      value: this.topicPrefix,
      description: "SNS topic ARN prefix for per-domain routing",
    });
  }
}
