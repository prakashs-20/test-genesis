// SLI metric filters, SLO latency alarms, burn-rate composite alarms, infra alarms, and the operator dashboard.

import * as cdk from "aws-cdk-lib";
import {
  Duration,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cw_actions,
  aws_logs as logs,
  aws_elasticloadbalancingv2 as elbv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";
import type { ComputeStack } from "./compute-stack.js";
import type { DatabaseStack } from "./database-stack.js";
import type { MessagingStack } from "./messaging-stack.js";
import type { TemporalStack } from "./temporal-stack.js";
import { SLIS, burnRateAlarms, errorBudgetMinutesPerMonth } from "./slo.js";

const SLI_METRIC_NAMESPACE = "Axira/SLI";

export class MonitoringStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    compute: ComputeStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    temporal: TemporalStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const action = new cw_actions.SnsAction(messaging.opsAlarmTopic);

    const sliMetrics = this.registerSliMetricFilters(envCfg);
    this.registerSliLatencyAlarms(envCfg, sliMetrics, action);
    this.registerAvailabilityBurnRateAlarms(envCfg, compute, action);
    this.registerInfraAlarms(envCfg, compute, database, messaging, action);
    this.registerPlatformHealthAlarms(
      envCfg,
      compute,
      database,
      messaging,
      temporal,
      action,
    );
    this.buildDashboard(envCfg, compute, database, messaging, sliMetrics);
  }

  private registerSliMetricFilters(
    envCfg: EnvConfig,
  ): Record<string, cloudwatch.Metric> {
    const metrics: Record<string, cloudwatch.Metric> = {};

    for (const sli of SLIS) {
      const logGroup = logs.LogGroup.fromLogGroupName(
        this,
        `LogGroupFor-${sli.id}`,
        `/axira/${envCfg.name}/${sli.logGroupSuffix}`,
      );

      // No `dimensions` block: CloudWatch MetricFilter dimension VALUES must
      // be JSON selectors (e.g. `$.env`) — literal strings are rejected with
      // "dimension value must be valid selector". The metric is already
      // scoped per-account+region so cross-env collisions can't happen.
      // If you later add `env` to the JSON log line itself (via
      // `@axira/observability`), switch to: dimensions: { Env: "$.env" }
      // and dimensionsMap accordingly.
      new logs.MetricFilter(this, `SliFilter-${sli.id}`, {
        logGroup,
        metricNamespace: SLI_METRIC_NAMESPACE,
        metricName: sli.metricName,
        filterPattern: logs.FilterPattern.literal(sli.filterPattern),
        metricValue: "$.latency_ms",
        unit: cloudwatch.Unit.MILLISECONDS,
      });

      metrics[sli.id] = new cloudwatch.Metric({
        namespace: SLI_METRIC_NAMESPACE,
        metricName: sli.metricName,
        statistic: "p95",
        period: Duration.minutes(5),
        unit: cloudwatch.Unit.MILLISECONDS,
      });
    }

    return metrics;
  }

  private registerSliLatencyAlarms(
    envCfg: EnvConfig,
    sliMetrics: Record<string, cloudwatch.Metric>,
    action: cw_actions.SnsAction,
  ): void {
    for (const sli of SLIS) {
      const metric = sliMetrics[sli.id]!;
      const threshold = sli.thresholdMs(envCfg.slo);

      new cloudwatch.Alarm(this, `SliLatency-${sli.id}`, {
        alarmName: `axira-${envCfg.name}-slo-${sli.id}-latency`,
        metric,
        threshold,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${sli.description}. SLO target: p95 < ${threshold} ms. Sustained 15 min above threshold.`,
      }).addAlarmAction(action);
    }
  }

  private registerAvailabilityBurnRateAlarms(
    envCfg: EnvConfig,
    compute: ComputeStack,
    action: cw_actions.SnsAction,
  ): void {
    const errorBudgetRate = 1 - envCfg.slo.availabilityTarget;

    for (const burn of burnRateAlarms(envCfg.slo)) {
      const window = Duration.minutes(burn.windowMinutes);

      const errorRate = new cloudwatch.MathExpression({
        label: `Error rate over ${burn.windowMinutes}m`,
        expression: "IF(req == 0, 0, errs / req)",
        usingMetrics: {
          errs: compute.alb.metrics.httpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
            {
              period: window,
              statistic: "Sum",
            },
          ),
          req: compute.alb.metrics.requestCount({
            period: window,
            statistic: "Sum",
          }),
        },
        period: window,
      });

      new cloudwatch.Alarm(this, `BurnRate-${burn.id}`, {
        alarmName: `axira-${envCfg.name}-slo-availability-burn-${burn.id}`,
        metric: errorRate,
        threshold: errorBudgetRate * burn.burnRate,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${burn.description}. Monthly budget: ${errorBudgetMinutesPerMonth(envCfg.slo)} min.`,
      }).addAlarmAction(action);
    }
  }

  private registerInfraAlarms(
    envCfg: EnvConfig,
    compute: ComputeStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    action: cw_actions.SnsAction,
  ): void {
    for (const [name, svc] of Object.entries(compute.fargateServices)) {
      new cloudwatch.Alarm(this, `CpuHigh-${name}`, {
        alarmName: `axira-${envCfg.name}-${name}-cpu-high`,
        metric: svc.metricCpuUtilization({ period: Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${name}: CPU > 85% for 15 minutes`,
      }).addAlarmAction(action);

      new cloudwatch.Alarm(this, `MemHigh-${name}`, {
        alarmName: `axira-${envCfg.name}-${name}-mem-high`,
        metric: svc.metricMemoryUtilization({ period: Duration.minutes(5) }),
        threshold: 85,
        evaluationPeriods: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        alarmDescription: `${name}: memory > 85% for 15 minutes`,
      }).addAlarmAction(action);
    }

    new cloudwatch.Alarm(this, "AuroraCpu", {
      alarmName: `axira-${envCfg.name}-aurora-cpu`,
      metric: database.auroraCluster.metricCPUUtilization({
        period: Duration.minutes(5),
      }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, "AuroraReplicaLag", {
      alarmName: `axira-${envCfg.name}-aurora-replica-lag`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/RDS",
        metricName: "AuroraReplicaLag",
        dimensionsMap: {
          DBClusterIdentifier: database.auroraCluster.clusterIdentifier,
        },
        statistic: "Average",
        period: Duration.minutes(5),
      }),
      threshold: 1000,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, "OpenSearchClusterRed", {
      alarmName: `axira-${envCfg.name}-opensearch-red`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/ES",
        metricName: "ClusterStatus.red",
        dimensionsMap: {
          DomainName: database.opensearch.domainName,
          ClientId: this.account,
        },
        statistic: "Maximum",
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(action);

    for (const [name, bundle] of Object.entries(messaging.queues)) {
      new cloudwatch.Alarm(this, `Dlq-${name}`, {
        alarmName: `axira-${envCfg.name}-${name}-dlq-not-empty`,
        metric: bundle.mainDlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: `${name} DLQ has messages; consumer is failing.`,
      }).addAlarmAction(action);
      if (bundle.priorityDlq) {
        new cloudwatch.Alarm(this, `Dlq-${name}-priority`, {
          alarmName: `axira-${envCfg.name}-${name}-priority-dlq-not-empty`,
          metric: bundle.priorityDlq.metricApproximateNumberOfMessagesVisible({
            period: Duration.minutes(1),
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        }).addAlarmAction(action);
      }
    }
  }

  // Platform-edge + dependency health alarms layered on top of the SLO and the
  // per-service CPU/mem alarms in registerInfraAlarms. Every alarm wires to the
  // same opsAlarmTopic via the shared `action`.
  private registerPlatformHealthAlarms(
    envCfg: EnvConfig,
    compute: ComputeStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    temporal: TemporalStack,
    action: cw_actions.SnsAction,
  ): void {
    this.registerAlb5xxAlarms(envCfg, compute, action);
    // Per-target-group UnHealthyHostCount alarms (gateway/experience/admin-hub)
    // are defined in ComputeStack, co-located with each target group. Reading a
    // TG's TargetGroupFullName across stacks forces a CloudFormation export that
    // blocks the placeholder→real image flip (the flip replaces the TG, which
    // changes the exported value, and CFN refuses to update an in-use export).
    // See ComputeStack.createService (the `UnhealthyHosts-` alarm) for details.
    this.registerSqsBacklogAlarm(envCfg, messaging, action);
    this.registerRedisAlarms(envCfg, database, action);
    this.registerBedrockAlarm(envCfg, action);
    this.registerTemporalServiceAlarm(envCfg, temporal, action);
  }

  // ALB 5xx: separate alarms for target-origin and ELB-origin 5xx. Both use an
  // absolute Sum-over-5-min threshold of 10: small enough to catch a real
  // regression for ~20 concurrent users, large enough to ride out a single
  // transient blip. (Chose absolute count over a 5xx/request MathExpression
  // ratio: at low traffic a ratio spikes to 100% on one error during a quiet
  // minute and false-alarms; the burn-rate alarm already covers the ratio view
  // of availability.)
  private registerAlb5xxAlarms(
    envCfg: EnvConfig,
    compute: ComputeStack,
    action: cw_actions.SnsAction,
  ): void {
    new cloudwatch.Alarm(this, "Alb5xxTarget", {
      alarmName: `axira-${envCfg.name}-alb-target-5xx`,
      metric: compute.alb.metrics.httpCodeTarget(
        elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
        { period: Duration.minutes(5), statistic: "Sum" },
      ),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Targets returned > 10 HTTP 5xx in 5 minutes; a platform service is erroring.",
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, "Alb5xxElb", {
      alarmName: `axira-${envCfg.name}-alb-elb-5xx`,
      metric: compute.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 10,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "ALB itself returned > 10 HTTP 5xx in 5 minutes (no healthy target / 502 / 503 / 504).",
    }).addAlarmAction(action);
  }

  // Poison-message coverage (DLQ ApproximateNumberOfMessagesVisible >= 1) is
  // already registered for every DLQ in registerInfraAlarms. This adds the
  // missing backlog-age signal on the main projection-consumer queue: when the
  // oldest unprocessed projection event is older than 15 minutes the read model
  // is going stale even if depth looks bounded (slow consumer, not a poison
  // pill). projection-consumer is the spine queue; if it is absent (env without
  // that queue) skip silently.
  private registerSqsBacklogAlarm(
    envCfg: EnvConfig,
    messaging: MessagingStack,
    action: cw_actions.SnsAction,
  ): void {
    const projection = messaging.queues["projection-consumer"];
    if (!projection) return;
    new cloudwatch.Alarm(this, "ProjectionQueueAge", {
      alarmName: `axira-${envCfg.name}-projection-consumer-age-high`,
      metric: projection.main.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(1),
        statistic: "Maximum",
      }),
      threshold: 900,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Oldest projection event > 900s old for 3 minutes; read models are falling behind.",
    }).addAlarmAction(action);
  }

  // Redis (ElastiCache replication group): three separate alarms - CPU > 80%,
  // DatabaseMemoryUsagePercentage > 80%, and Evictions > 0. Kept as three
  // alarms (not one composite) so the page names the exact dimension that
  // breached. Metrics are read at the replication-group level via the
  // ReplicationGroupId dimension (account-wide ElastiCache namespace), which
  // aggregates the primary + replica nodes without hardcoding the per-node
  // `<group>-001` CacheClusterId suffix.
  private registerRedisAlarms(
    envCfg: EnvConfig,
    database: DatabaseStack,
    action: cw_actions.SnsAction,
  ): void {
    const replicationGroupId = database.redis.replicationGroupId!;
    const redisMetric = (
      metricName: string,
      statistic: string,
    ): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: "AWS/ElastiCache",
        metricName,
        dimensionsMap: { ReplicationGroupId: replicationGroupId },
        statistic,
        period: Duration.minutes(5),
      });

    new cloudwatch.Alarm(this, "RedisCpuHigh", {
      alarmName: `axira-${envCfg.name}-redis-cpu-high`,
      metric: redisMetric("CPUUtilization", "Average"),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Redis CPU > 80% for 15 minutes.",
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, "RedisMemoryHigh", {
      alarmName: `axira-${envCfg.name}-redis-memory-high`,
      metric: redisMetric("DatabaseMemoryUsagePercentage", "Average"),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Redis used-memory > 80% for 15 minutes.",
    }).addAlarmAction(action);

    new cloudwatch.Alarm(this, "RedisEvictions", {
      alarmName: `axira-${envCfg.name}-redis-evictions`,
      metric: redisMetric("Evictions", "Sum"),
      threshold: 0,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Redis evicted keys for 3 minutes; the cache is over capacity and dropping data.",
    }).addAlarmAction(action);
  }

  // Bedrock throttling: account+region-level AWS/Bedrock metric, no dimensions
  // (the throttle ceiling is an account quota, not per-model). Sum >= 1 over 5
  // min means we are being throttled and inference latency/failures will follow.
  private registerBedrockAlarm(
    envCfg: EnvConfig,
    action: cw_actions.SnsAction,
  ): void {
    new cloudwatch.Alarm(this, "BedrockThrottles", {
      alarmName: `axira-${envCfg.name}-bedrock-throttles`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/Bedrock",
        metricName: "InvocationThrottles",
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Bedrock returned >= 1 InvocationThrottles in 5 minutes; request a quota increase or shed load.",
    }).addAlarmAction(action);
  }

  // Temporal service health proxy: RunningTaskCount < desiredCount. The
  // RunningTaskCount metric lives in the ECS/ContainerInsights namespace
  // (Container Insights is enabled on the cluster). dimensionsMap uses the
  // deterministic cluster name (axira-<env>) and the service's own serviceName
  // token. Richer Temporal task-queue depth / workflow-latency metrics need the
  // OTel -> CloudWatch pipeline and are deferred.
  private registerTemporalServiceAlarm(
    envCfg: EnvConfig,
    temporal: TemporalStack,
    action: cw_actions.SnsAction,
  ): void {
    new cloudwatch.Alarm(this, "TemporalRunningTasks", {
      alarmName: `axira-${envCfg.name}-temporal-running-tasks-low`,
      metric: new cloudwatch.Metric({
        namespace: "ECS/ContainerInsights",
        metricName: "RunningTaskCount",
        dimensionsMap: {
          ClusterName: `axira-${envCfg.name}`,
          ServiceName: temporal.service.serviceName,
        },
        statistic: "Minimum",
        period: Duration.minutes(1),
      }),
      threshold: temporal.desiredCount,
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: `Temporal running tasks below desired (${temporal.desiredCount}) for 5 minutes; the cluster is degraded.`,
    }).addAlarmAction(action);
  }

  private buildDashboard(
    envCfg: EnvConfig,
    compute: ComputeStack,
    database: DatabaseStack,
    messaging: MessagingStack,
    sliMetrics: Record<string, cloudwatch.Metric>,
  ): void {
    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: `axira-${envCfg.name}`,
    });

    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: [
          `# Axira ${envCfg.name}`,
          `SLO availability target: ${(envCfg.slo.availabilityTarget * 100).toFixed(2)}%`,
          `Monthly error budget: ${errorBudgetMinutesPerMonth(envCfg.slo)} minutes`,
          `SLI thresholds: conversation first paint ${envCfg.slo.conversationFirstPaintMs}ms / ` +
            `end-to-end ${envCfg.slo.conversationEndToEndMs}ms / ` +
            `deal progress ${envCfg.slo.dealProgressMs}ms`,
        ].join("\n\n"),
        width: 24,
        height: 4,
      }),
    );

    const sliWidgets: cloudwatch.IWidget[] = SLIS.map(
      (sli) =>
        new cloudwatch.GraphWidget({
          title: `SLI: ${sli.id}`,
          left: [sliMetrics[sli.id]!.with({ statistic: "p95", label: "p95" })],
          leftAnnotations: [
            { value: sli.thresholdMs(envCfg.slo), label: "SLO threshold" },
          ],
          width: 8,
          height: 6,
        }),
    );
    dashboard.addWidgets(...sliWidgets);

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "ALB requests and target 5xx",
        left: [compute.alb.metrics.requestCount({ label: "requests" })],
        right: [
          compute.alb.metrics.httpCodeTarget(
            elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
            { label: "target 5xx" },
          ),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "ALB target response time",
        left: [
          compute.alb.metrics.targetResponseTime({
            statistic: "p50",
            label: "p50",
          }),
          compute.alb.metrics.targetResponseTime({
            statistic: "p95",
            label: "p95",
          }),
          compute.alb.metrics.targetResponseTime({
            statistic: "p99",
            label: "p99",
          }),
        ],
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Service CPU",
        left: Object.values(compute.fargateServices).map((s) =>
          s.metricCpuUtilization({ label: s.serviceName }),
        ),
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Service memory",
        left: Object.values(compute.fargateServices).map((s) =>
          s.metricMemoryUtilization({ label: s.serviceName }),
        ),
        width: 12,
        height: 6,
      }),
    );

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "Aurora",
        left: [database.auroraCluster.metricCPUUtilization({ label: "CPU %" })],
        right: [
          new cloudwatch.Metric({
            namespace: "AWS/RDS",
            metricName: "ServerlessDatabaseCapacity",
            dimensionsMap: {
              DBClusterIdentifier: database.auroraCluster.clusterIdentifier,
            },
            statistic: "Average",
            label: "ACU",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Queue depth",
        left: Object.values(messaging.queues).map((b) =>
          b.main.metricApproximateNumberOfMessagesVisible({
            label: b.main.queueName,
          }),
        ),
        width: 12,
        height: 6,
      }),
    );
  }
}
