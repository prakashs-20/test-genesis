import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import type { ComputeStack } from "./compute-stack.js";
import type { DatabaseStack } from "./database-stack.js";

export class MonitoringStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    compute: ComputeStack,
    database: DatabaseStack,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    // Log groups for each service
    const services = [
      "axira-gateway",
      "axira-workflow-engine",
      "axira-agent-runtime",
      "axira-experience",
    ];
    for (const svc of services) {
      new logs.LogGroup(this, `${svc}-logs`, {
        logGroupName: `/axira/${config.env}/${svc}`,
        retention:
          config.env === "production"
            ? logs.RetentionDays.NINETY_DAYS
            : logs.RetentionDays.THIRTY_DAYS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // SNS alarm topic
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `axira-${config.env}-alarms`,
    });

    // RDS alarms
    new cloudwatch.Alarm(this, "DbCpuAlarm", {
      metric: database.dbInstance.metricCPUUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      alarmDescription: `RDS CPU > 80% for ${config.env}`,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, "DbConnectionsAlarm", {
      metric: database.dbInstance.metricDatabaseConnections(),
      threshold: 150,
      evaluationPeriods: 2,
      alarmDescription: `RDS connections > 150 for ${config.env}`,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, "DbStorageAlarm", {
      metric: database.dbInstance.metricFreeStorageSpace(),
      threshold: 10 * 1024 * 1024 * 1024, // 10 GB
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      alarmDescription: `RDS free storage < 10GB for ${config.env}`,
    }).addAlarmAction(new actions.SnsAction(alarmTopic));

    // ECS service alarms
    for (const [name, service] of compute.services) {
      new cloudwatch.Alarm(this, `${name}-cpu-alarm`, {
        metric: service.metricCpuUtilization(),
        threshold: 85,
        evaluationPeriods: 3,
        alarmDescription: `${name} CPU > 85% for ${config.env}`,
      }).addAlarmAction(new actions.SnsAction(alarmTopic));

      new cloudwatch.Alarm(this, `${name}-memory-alarm`, {
        metric: service.metricMemoryUtilization(),
        threshold: 85,
        evaluationPeriods: 3,
        alarmDescription: `${name} memory > 85% for ${config.env}`,
      }).addAlarmAction(new actions.SnsAction(alarmTopic));
    }

    // Dashboard
    new cloudwatch.Dashboard(this, "AxiraDashboard", {
      dashboardName: `axira-${config.env}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "ECS CPU Utilization",
            left: [...compute.services.values()].map((s) =>
              s.metricCpuUtilization(),
            ),
          }),
          new cloudwatch.GraphWidget({
            title: "ECS Memory Utilization",
            left: [...compute.services.values()].map((s) =>
              s.metricMemoryUtilization(),
            ),
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "RDS CPU",
            left: [database.dbInstance.metricCPUUtilization()],
          }),
          new cloudwatch.GraphWidget({
            title: "RDS Connections",
            left: [database.dbInstance.metricDatabaseConnections()],
          }),
        ],
      ],
    });
  }
}
