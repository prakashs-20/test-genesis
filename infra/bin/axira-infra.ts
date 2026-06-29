import * as cdk from "aws-cdk-lib";
import { getConfig, type Environment } from "../lib/config.js";
import { NetworkStack } from "../lib/network-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { MessagingStack } from "../lib/messaging-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { TemporalStack } from "../lib/temporal-stack.js";
import { SecretsStack } from "../lib/secrets-stack.js";
import { ComputeStack } from "../lib/compute-stack.js";
import { CDNStack } from "../lib/cdn-stack.js";
import { MonitoringStack } from "../lib/monitoring-stack.js";
import { ObservabilityStack } from "../lib/observability-stack.js";

const app = new cdk.App();
const envName = (app.node.tryGetContext("env") || "staging") as Environment;
const config = getConfig(envName);

const env = { account: config.account, region: config.region };

const network = new NetworkStack(app, `Axira-${envName}-Network`, config, {
  env,
});
const secrets = new SecretsStack(app, `Axira-${envName}-Secrets`, config, {
  env,
});
const database = new DatabaseStack(
  app,
  `Axira-${envName}-Database`,
  config,
  network,
  { env },
);
const messaging = new MessagingStack(
  app,
  `Axira-${envName}-Messaging`,
  config,
  { env },
);
const _storage = new StorageStack(app, `Axira-${envName}-Storage`, config, {
  env,
});
const temporal = new TemporalStack(
  app,
  `Axira-${envName}-Temporal`,
  config,
  network,
  { env },
);
// ObservabilityStack runs BEFORE ComputeStack so its
// `otelCollectorEndpoint` can be wired into every customer-cluster
// service task definition's OTEL_EXPORTER_OTLP_ENDPOINT (Session 2.2).
const observability = new ObservabilityStack(
  app,
  `Axira-${envName}-Observability`,
  {
    env,
    config,
    vpc: network.vpc,
    ecsSecurityGroup: network.ecsSecurityGroup,
  },
);
const compute = new ComputeStack(
  app,
  `Axira-${envName}-Compute`,
  config,
  network,
  database,
  messaging,
  temporal,
  observability,
  secrets,
  { env },
);
new CDNStack(app, `Axira-${envName}-CDN`, config, compute, { env });
new MonitoringStack(
  app,
  `Axira-${envName}-Monitoring`,
  config,
  compute,
  database,
  { env },
);

app.synth();
