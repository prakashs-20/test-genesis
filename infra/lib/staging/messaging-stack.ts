// SNS topics per event domain, SQS consumer queues with DLQs, fan-out subscriptions, and the ops alarm topic.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  CfnOutput,
  aws_iam as iam,
  aws_kms as kms,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig, SqsQueueDef } from "./config.js";

const QUEUE_TO_ENV_VAR: Record<string, string> = {
  "projection-consumer": "SQS_PROJECTION_QUEUE_URL",
  "search-indexer": "SQS_SEARCH_INDEX_QUEUE_URL",
  "notification-dispatcher": "SQS_NOTIFICATION_QUEUE_URL",
  "compliance-monitor": "SQS_COMPLIANCE_QUEUE_URL",
  "agui-streamer": "SQS_EVENT_SIGNAL_QUEUE_URL",
  "workflow-trigger": "SQS_WORKFLOW_TRIGGER_QUEUE_URL",
  "webhook-dispatcher": "SQS_WEBHOOK_DISPATCHER_QUEUE_URL",
  "governance-events": "SQS_GOVERNANCE_EVENTS_QUEUE_URL",
  "reconciliation-starter": "SQS_RECONCILIATION_STARTER_QUEUE_URL",
};

const PRIORITY_QUEUE_ENV_VAR: Record<string, string> = {
  "projection-consumer": "SQS_PROJECTION_PRIORITY_QUEUE_URL",
};

const DLQ_ENV_VAR: Record<string, string> = {
  "projection-consumer": "SQS_PROJECTION_DLQ_URL",
  "search-indexer": "SQS_SEARCH_INDEX_DLQ_URL",
  "notification-dispatcher": "SQS_NOTIFICATION_DLQ_URL",
  "compliance-monitor": "SQS_COMPLIANCE_DLQ_URL",
  "agui-streamer": "SQS_AGUI_STREAMER_DLQ_URL",
  "webhook-dispatcher": "SQS_WEBHOOK_DISPATCHER_DLQ_URL",
};

const PRIORITY_DLQ_ENV_VAR: Record<string, string> = {
  "projection-consumer": "SQS_PROJECTION_PRIORITY_DLQ_URL",
};

export interface MessagingQueueBundle {
  readonly main: sqs.Queue;
  readonly mainDlq: sqs.Queue;
  readonly priority?: sqs.Queue;
  readonly priorityDlq?: sqs.Queue;
}

export class MessagingStack extends cdk.Stack {
  public readonly topics: Record<string, sns.Topic> = {};
  public readonly topicPrefix: string;
  public readonly queues: Record<string, MessagingQueueBundle> = {};
  public readonly opsAlarmTopic: sns.Topic;

  public readonly serviceQueueEnvVars: Record<string, string> = {};

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    key: kms.IKey,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.topicPrefix = `arn:aws:sns:${this.region}:${this.account}:axira-${envCfg.name}-events`;

    for (const domain of envCfg.snsDomains) {
      const topic = new sns.Topic(this, `Topic-${domain}`, {
        topicName: `axira-${envCfg.name}-events-${domain}`,
        displayName: `axira ${envCfg.name} ${domain} events`,
        masterKey: key as kms.Key,
      });
      this.topics[domain] = topic;
    }

    for (const def of envCfg.sqsQueues) {
      this.queues[def.logicalId] = this.createQueueBundle(envCfg, def, key);
    }

    // Fan-out wiring. Default CDK pattern (`topic.addSubscription(new
    // SqsSubscription(queue))`) adds one Allow statement to the queue's
    // resource policy *per topic*. With 24 topics that exceeds SQS's hard
    // limit of 20 policy statements per queue. Instead:
    //
    //   1. Add ONE wildcard policy statement per queue allowing any axira
    //      events topic in this account to publish (collapses 24 → 1).
    //   2. Create subscriptions via L1 `CfnSubscription`, which does not
    //      auto-mutate the queue's resource policy.
    //
    // KMS-side permission for SNS to encrypt messages with the platform CMK
    // before delivery is granted statically by the CMK's account-root key
    // policy (default behavior of `new kms.Key(...)` without restrictive
    // policy override) — IAM-based access works for SNS publish flow.
    const topicArnWildcard = `${this.topicPrefix}-*`;
    const wildcardSnsStatement = (queueArn: string): iam.PolicyStatement =>
      new iam.PolicyStatement({
        sid: "AllowAxiraSnsTopicsToSend",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("sns.amazonaws.com")],
        actions: ["sqs:SendMessage"],
        resources: [queueArn],
        conditions: { ArnLike: { "aws:SourceArn": topicArnWildcard } },
      });

    for (const bundle of Object.values(this.queues)) {
      bundle.main.addToResourcePolicy(
        wildcardSnsStatement(bundle.main.queueArn),
      );
      if (bundle.priority) {
        bundle.priority.addToResourcePolicy(
          wildcardSnsStatement(bundle.priority.queueArn),
        );
      }
    }

    for (const [domain, topic] of Object.entries(this.topics)) {
      for (const [logicalId, bundle] of Object.entries(this.queues)) {
        new sns.CfnSubscription(this, `Sub-${domain}-${logicalId}`, {
          topicArn: topic.topicArn,
          protocol: "sqs",
          endpoint: bundle.main.queueArn,
          rawMessageDelivery: true,
        });
        if (bundle.priority) {
          new sns.CfnSubscription(this, `Sub-${domain}-${logicalId}-priority`, {
            topicArn: topic.topicArn,
            protocol: "sqs",
            endpoint: bundle.priority.queueArn,
            rawMessageDelivery: true,
          });
        }
      }
    }

    this.opsAlarmTopic = new sns.Topic(this, "OpsAlarms", {
      topicName: `axira-${envCfg.name}-ops-alarms`,
      displayName: `Axira ${envCfg.name} operational alarms`,
      masterKey: key as kms.Key,
    });

    // ─── Microsoft Teams notify topic + dedicated queue ─────────────────────
    // T2.1 of msteams-integration-build. The workflow-engine notification
    // dispatcher publishes here when a tenant_notification_routing_rules row
    // sets teams_target IS NOT NULL. The apps/teams-bot SQS consumer
    // long-polls the dedicated queue, runs classification + guard + render,
    // and writes card_dispatch_log. Subscription uses
    // RawMessageDelivery=true + a target_kind="teams" message-attribute
    // filter to keep noise out of the queue. KMS-encrypted with the
    // platform CMK; DLQ retains 14d.
    const teamsTopic = new sns.Topic(this, "TopicTeamsNotify", {
      topicName: `axira-${envCfg.name}-events-teams-notify`,
      displayName: `axira ${envCfg.name} teams notify`,
      masterKey: key as kms.Key,
    });
    this.topics["teams-notify"] = teamsTopic;
    const teamsNotifyDlq = this.makeDlq(
      `axira-${envCfg.name}-teams-notify`,
      key,
    );
    const teamsNotifyQueue = new sqs.Queue(this, "QueueTeamsNotify", {
      queueName: `axira-${envCfg.name}-teams-notify`,
      visibilityTimeout: Duration.seconds(120),
      retentionPeriod: Duration.days(7),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      deadLetterQueue: { maxReceiveCount: 5, queue: teamsNotifyDlq },
    });
    this.queues["teams-notify"] = {
      main: teamsNotifyQueue,
      mainDlq: teamsNotifyDlq,
    };
    teamsNotifyQueue.addToResourcePolicy(
      wildcardSnsStatement(teamsNotifyQueue.queueArn),
    );
    new sns.CfnSubscription(this, "SubTeamsNotify", {
      topicArn: teamsTopic.topicArn,
      protocol: "sqs",
      endpoint: teamsNotifyQueue.queueArn,
      rawMessageDelivery: true,
      filterPolicyScope: "MessageAttributes",
      // CfnSubscription.filterPolicy must be an object (CDK serializes it to
      // CloudFormation); passing a pre-stringified JSON fails synth with
      // "should be an 'object'".
      filterPolicy: { target_kind: ["teams"] },
    });
    this.serviceQueueEnvVars["SQS_TEAMS_NOTIFY_QUEUE_URL"] =
      teamsNotifyQueue.queueUrl;
    this.serviceQueueEnvVars["SQS_TEAMS_NOTIFY_DLQ_URL"] =
      teamsNotifyDlq.queueUrl;
    this.serviceQueueEnvVars["SNS_TEAMS_NOTIFY_TOPIC_ARN"] =
      teamsTopic.topicArn;

    // ─── T7.1 — Teams tombstone topic + dedicated queue ─────────────────────
    // DSR purge + fact deletion + legal hold events fan out here. The
    // apps/teams-bot tombstone consumer long-polls the dedicated queue,
    // walks card_dispatch_log for affected entities, and calls Bot
    // Framework deleteActivity (with redacted-replacement fallback).
    // No subscription filter — every message is a tombstone-relevant
    // event; the consumer's Zod envelope schema dispatches on event_type.
    const teamsTombstoneTopic = new sns.Topic(this, "TopicTeamsTombstone", {
      topicName: `axira-${envCfg.name}-events-teams-tombstone`,
      displayName: `axira ${envCfg.name} teams tombstone`,
      masterKey: key as kms.Key,
    });
    this.topics["teams-tombstone"] = teamsTombstoneTopic;
    const teamsTombstoneDlq = this.makeDlq(
      `axira-${envCfg.name}-teams-tombstone`,
      key,
    );
    const teamsTombstoneQueue = new sqs.Queue(this, "QueueTeamsTombstone", {
      queueName: `axira-${envCfg.name}-teams-tombstone`,
      visibilityTimeout: Duration.seconds(120),
      retentionPeriod: Duration.days(7),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      deadLetterQueue: { maxReceiveCount: 5, queue: teamsTombstoneDlq },
    });
    this.queues["teams-tombstone"] = {
      main: teamsTombstoneQueue,
      mainDlq: teamsTombstoneDlq,
    };
    teamsTombstoneQueue.addToResourcePolicy(
      wildcardSnsStatement(teamsTombstoneQueue.queueArn),
    );
    new sns.CfnSubscription(this, "SubTeamsTombstone", {
      topicArn: teamsTombstoneTopic.topicArn,
      protocol: "sqs",
      endpoint: teamsTombstoneQueue.queueArn,
      rawMessageDelivery: true,
    });
    this.serviceQueueEnvVars["SQS_TEAMS_TOMBSTONE_QUEUE_URL"] =
      teamsTombstoneQueue.queueUrl;
    this.serviceQueueEnvVars["SQS_TEAMS_TOMBSTONE_DLQ_URL"] =
      teamsTombstoneDlq.queueUrl;
    this.serviceQueueEnvVars["SNS_TEAMS_TOMBSTONE_TOPIC_ARN"] =
      teamsTombstoneTopic.topicArn;

    this.serviceQueueEnvVars["SNS_TOPIC_PREFIX"] = this.topicPrefix;
    for (const def of envCfg.sqsQueues) {
      const bundle = this.queues[def.logicalId];
      this.serviceQueueEnvVars[QUEUE_TO_ENV_VAR[def.logicalId]!] =
        bundle.main.queueUrl;
      if (DLQ_ENV_VAR[def.logicalId]) {
        this.serviceQueueEnvVars[DLQ_ENV_VAR[def.logicalId]!] =
          bundle.mainDlq.queueUrl;
      }
      if (bundle.priority) {
        this.serviceQueueEnvVars[PRIORITY_QUEUE_ENV_VAR[def.logicalId]!] =
          bundle.priority.queueUrl;
        if (bundle.priorityDlq) {
          this.serviceQueueEnvVars[PRIORITY_DLQ_ENV_VAR[def.logicalId]!] =
            bundle.priorityDlq.queueUrl;
        }
      }
    }

    new CfnOutput(this, "TopicPrefix", { value: this.topicPrefix });
    new CfnOutput(this, "OpsAlarmTopicArn", {
      value: this.opsAlarmTopic.topicArn,
    });
  }

  private createQueueBundle(
    envCfg: EnvConfig,
    def: SqsQueueDef,
    key: kms.IKey,
  ): MessagingQueueBundle {
    const baseName = `axira-${envCfg.name}-${def.logicalId}`;

    const mainDlq = this.makeDlq(baseName, key);
    const main = this.makeQueue(baseName, def, mainDlq, key);

    if (!def.priorityLane) {
      return { main, mainDlq };
    }

    const priorityDlq = this.makeDlq(`${baseName}-priority`, key);
    const priority = this.makeQueue(
      `${baseName}-priority`,
      def,
      priorityDlq,
      key,
    );
    return { main, mainDlq, priority, priorityDlq };
  }

  private makeDlq(baseName: string, key: kms.IKey): sqs.Queue {
    return new sqs.Queue(this, `Dlq-${baseName}`, {
      queueName: `${baseName}-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
    });
  }

  private makeQueue(
    baseName: string,
    def: SqsQueueDef,
    dlq: sqs.Queue,
    key: kms.IKey,
  ): sqs.Queue {
    return new sqs.Queue(this, `Queue-${baseName}`, {
      queueName: baseName,
      visibilityTimeout: Duration.seconds(def.visibilityTimeoutSeconds),
      retentionPeriod: Duration.days(def.retentionDays),
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: key,
      deadLetterQueue: { maxReceiveCount: 3, queue: dlq },
    });
  }
}
