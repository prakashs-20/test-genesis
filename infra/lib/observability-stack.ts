import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";
import {
  OtelCollectorConstruct,
  OTEL_COLLECTOR_NAMESPACE_NAME,
  OTEL_COLLECTOR_OTLP_HTTP_PORT,
  OTEL_COLLECTOR_SERVICE_NAME,
} from "./observability/otel-collector-construct.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ObservabilityStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly vpc: ec2.IVpc;
  readonly ecsSecurityGroup: ec2.ISecurityGroup;
  /**
   * Phoenix OTLP HTTP endpoint that the collector's traces/llm pipeline
   * exports to. Optional; defaults to the in-VPC Phoenix DNS placeholder
   * `https://phoenix.axira.local/v1/traces`. Phoenix's own deployment
   * is out of scope for Session 2.2 (it exists already per
   * docs/ai-context/reference/observability-architecture.md:172).
   */
  readonly phoenixEndpoint?: string;
}

/**
 * Customer-side observability stack.
 *
 * Session 2.1 contents:
 *   - `axira-logs` OpenSearch 2.17 domain (sibling to `axira-search` in
 *     DatabaseStack at infra/lib/database-stack.ts:131). Default tier:
 *     t3.medium.search × 2 / 100 GB gp3 / single AZ / no master.
 *     Production-tier customers can override via
 *     EnvironmentConfig.logsOpensearch (infra/lib/config.ts).
 *   - Index templates for `axira-logs-*` and `axira-traces-*` with
 *     best_compression + the canonical correlation IDs mapped as
 *     keyword. Pulled from
 *     infra/lib/observability/index-templates/*.json at synth time.
 *   - ISM policies for both index families: hot → force_merge(1d) →
 *     delete(15d). No UltraWarm, no cold S3 - see
 *     docs/ai-context/decisions/0004-no-ultrawarm-no-cold-for-logs.md.
 *   - One inline Node 22 Lambda that PUTs the templates and policies
 *     via SigV4-signed HTTPS against the domain endpoint. Invoked via
 *     `cr.Provider` + 4 `cdk.CustomResource` resources at stack
 *     create / update; idempotent (ISM policies pass `if_seq_no` +
 *     `if_primary_term` on update).
 *
 * Session 2.2 additions (this file):
 *   - Dedicated ECS cluster `axira-${env}-observability` (Container
 *     Insights on) for the collector. Distinct from the application
 *     cluster in infra/lib/compute-stack.ts:36.
 *   - Private Cloud Map namespace `axira.local`. Coexists with the app
 *     services' namespace declared in infra/lib/compute-stack.ts:42.
 *   - ADOT Collector Fargate service (OtelCollectorConstruct) with
 *     SSM-delivered pipeline config, SigV4-signed OpenSearch sinks,
 *     filtered Phoenix sink for LLM spans, CloudWatch /axira/${env}/
 *     observability/otel-collector log group, CPU auto-scaling to 10.
 *
 * Session 2.3 is dropped per ADR 0004 (no cold S3 archive).
 *
 * Reference: docs/ai-context/reference/observability-architecture.md
 */
export class ObservabilityStack extends cdk.Stack {
  public readonly logsDomain: opensearch.Domain;
  public readonly logsDomainEndpoint: string;

  /**
   * Dedicated ECS cluster for observability data-plane services. Kept
   * separate from the application cluster in ComputeStack so collector
   * lifecycle (rolling restarts, autoscaling, image bumps) does not
   * affect customer-cluster app services.
   */
  public readonly observabilityCluster: ecs.Cluster;

  /**
   * Private Cloud Map namespace `axira.local`. Sibling to the app
   * services' namespace `services.${env}.axiralabs.internal` declared
   * in infra/lib/compute-stack.ts:42 - two namespaces coexist in the
   * same VPC and resolve via the VPC's default Route 53 resolver.
   */
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;

  /** The ADOT Collector construct. */
  public readonly otelCollector: OtelCollectorConstruct;

  /**
   * Deterministic OTLP HTTP endpoint for customer-cluster services.
   * Resolves to `http://otel-collector.axira.local:4318` once the
   * Cloud Map service registers. Session 2.2 wires this into all 4
   * service task defs in ComputeStack.
   */
  public readonly otelCollectorEndpoint: string;

  /** Collector SG id - exported so dependent stacks can grant egress. */
  public readonly otelCollectorSecurityGroupId: string;

  /** Reserved if a cold archive lands. Empty per ADR 0004. */
  public readonly coldStorageBucketName: string = "";

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { config, vpc, ecsSecurityGroup } = props;
    const sizing = config.logsOpensearch ?? {};

    // ── Security groups ────────────────────────────────────────────────
    //
    // Ingress on tcp/9200 from ECS mirrors the AxiraSearch convention at
    // infra/lib/network-stack.ts:106. Real OpenSearch HTTPS terminates on
    // 443; we also add 443 from both ECS (for the ADOT Collector landing
    // in Session 2.2) and from the setup Lambda's own SG (for the
    // bootstrap PUTs below).
    const logsSecurityGroup = new ec2.SecurityGroup(
      this,
      "AxiraLogsSecurityGroup",
      {
        vpc,
        description: "axira-logs OpenSearch - accepts ECS + setup Lambda",
        allowAllOutbound: false,
      },
    );
    logsSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(9200),
      "ECS to axira-logs (legacy port)",
    );
    logsSecurityGroup.addIngressRule(
      ecsSecurityGroup,
      ec2.Port.tcp(443),
      "ECS to axira-logs (HTTPS)",
    );

    const setupLambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      "AxiraLogsSetupSg",
      {
        vpc,
        description: "axira-logs setup Lambda - egress 443 to domain",
        allowAllOutbound: true,
      },
    );
    logsSecurityGroup.addIngressRule(
      setupLambdaSecurityGroup,
      ec2.Port.tcp(443),
      "setup Lambda to axira-logs",
    );

    // ── OpenSearch domain ─────────────────────────────────────────────
    this.logsDomain = new opensearch.Domain(this, "AxiraLogs", {
      domainName: `axira-logs-${config.env}`,
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      capacity: {
        dataNodeInstanceType: sizing.dataNodeInstanceType ?? "t3.medium.search",
        dataNodes: sizing.dataNodeCount ?? 2,
      },
      ebs: {
        volumeSize: sizing.ebsVolumeSize ?? 100,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      securityGroups: [logsSecurityGroup],
      zoneAwareness: { enabled: false },
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true },
      enforceHttps: true,
      removalPolicy:
        config.env === "production"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    this.logsDomainEndpoint = `https://${this.logsDomain.domainEndpoint}`;

    // ── Setup Lambda ──────────────────────────────────────────────────
    // SigV4-signed HTTPS PUT to the OpenSearch domain endpoint. The
    // OpenSearch templates + ISM policies live in HTTP-level APIs that
    // the standard AWS SDK control plane does not expose, so we sign
    // and call them directly. Node 22 Lambda runtime ships
    // @aws-sdk/signature-v4, @aws-sdk/protocol-http,
    // @aws-sdk/credential-provider-node, and @aws-crypto/sha256-js.
    const setupLambda = new lambda.Function(this, "AxiraLogsSetupLambda", {
      functionName: `axira-${config.env}-logs-setup`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [setupLambdaSecurityGroup],
      environment: {
        DOMAIN_ENDPOINT: this.logsDomain.domainEndpoint,
      },
      code: lambda.Code.fromInline(SETUP_LAMBDA_SOURCE),
    });
    setupLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "es:ESHttpGet",
          "es:ESHttpPut",
          "es:ESHttpPost",
          "es:ESHttpDelete",
        ],
        resources: [`${this.logsDomain.domainArn}/*`],
      }),
    );

    const provider = new cr.Provider(this, "AxiraLogsSetupProvider", {
      onEventHandler: setupLambda,
    });

    // ── 4 custom resources: 2 index templates + 2 ISM policies ────────
    const templatesDir = join(__dirname, "observability", "index-templates");
    const ismDir = join(__dirname, "observability", "ism");

    const logsTemplate = JSON.parse(
      readFileSync(join(templatesDir, "logs-template.json"), "utf8"),
    );
    const tracesTemplate = JSON.parse(
      readFileSync(join(templatesDir, "traces-template.json"), "utf8"),
    );
    const logsPolicy = JSON.parse(
      readFileSync(join(ismDir, "logs-policy.json"), "utf8"),
    );
    const tracesPolicy = JSON.parse(
      readFileSync(join(ismDir, "traces-policy.json"), "utf8"),
    );

    this.applyOpensearchResource(
      provider,
      "LogsIndexTemplate",
      "index_template",
      "_index_template/axira-logs",
      logsTemplate,
    );
    this.applyOpensearchResource(
      provider,
      "TracesIndexTemplate",
      "index_template",
      "_index_template/axira-traces",
      tracesTemplate,
    );
    this.applyOpensearchResource(
      provider,
      "LogsIsmPolicy",
      "ism_policy",
      "_plugins/_ism/policies/axira-logs-15d",
      logsPolicy,
    );
    this.applyOpensearchResource(
      provider,
      "TracesIsmPolicy",
      "ism_policy",
      "_plugins/_ism/policies/axira-traces-14d",
      tracesPolicy,
    );

    // ── Observability ECS cluster + Cloud Map namespace (Session 2.2) ──
    // Kept distinct from the application cluster (infra/lib/compute-stack.ts:36)
    // so observability lifecycle is independent. The namespace name is
    // `axira.local` - short, environment-agnostic, anchors the collector's
    // DNS record at otel-collector.axira.local.
    this.observabilityCluster = new ecs.Cluster(this, "ObservabilityCluster", {
      clusterName: `axira-${config.env}-observability`,
      vpc,
      containerInsights: true,
    });

    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "CloudMapNamespace",
      {
        name: OTEL_COLLECTOR_NAMESPACE_NAME,
        vpc,
        description:
          "Axira observability data-plane DNS namespace (Session 2.2). " +
          "Resolves otel-collector.axira.local in-VPC.",
      },
    );

    // ── ADOT Collector ────────────────────────────────────────────────
    this.otelCollector = new OtelCollectorConstruct(this, "OtelCollector", {
      vpc,
      ecsSecurityGroup,
      cluster: this.observabilityCluster,
      cloudMapNamespace: this.cloudMapNamespace,
      logsDomain: this.logsDomain,
      environmentName: config.env,
      clusterName: config.env,
      phoenixEndpoint:
        props.phoenixEndpoint ?? "https://phoenix.axira.local/v1/traces",
    });

    // Deterministic endpoint - the value is purely a function of the
    // namespace name + service name + port (all decided at synth time),
    // so dependent stacks can hard-wire it without an x-stack reference.
    this.otelCollectorEndpoint = `http://${OTEL_COLLECTOR_SERVICE_NAME}.${OTEL_COLLECTOR_NAMESPACE_NAME}:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`;
    this.otelCollectorSecurityGroupId =
      this.otelCollector.securityGroup.securityGroupId;
  }

  private applyOpensearchResource(
    provider: cr.Provider,
    id: string,
    kind: "index_template" | "ism_policy",
    apiPath: string,
    body: unknown,
  ): void {
    const resource = new cdk.CustomResource(this, id, {
      serviceToken: provider.serviceToken,
      properties: {
        Path: apiPath,
        Body: body,
        Kind: kind,
      },
    });
    resource.node.addDependency(this.logsDomain);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Inline Lambda source (CJS, Node 22 runtime). The handler receives
// CloudFormation custom-resource events through cr.Provider, signs an
// HTTPS PUT/GET/DELETE against the OpenSearch domain endpoint via
// SigV4, and surfaces the response to the Provider. ISM policy
// updates require optimistic-locking query params (if_seq_no /
// if_primary_term); the handler reads them via a GET probe before
// each PUT. Index template PUTs are fully idempotent and do not
// need the locking pair.
// ─────────────────────────────────────────────────────────────────────
const SETUP_LAMBDA_SOURCE = `
const https = require("node:https");
const { Sha256 } = require("@aws-crypto/sha256-js");
const { SignatureV4 } = require("@aws-sdk/signature-v4");
const { HttpRequest } = require("@aws-sdk/protocol-http");
const { defaultProvider } = require("@aws-sdk/credential-provider-node");

const REGION = process.env.AWS_REGION;
const DOMAIN_ENDPOINT = process.env.DOMAIN_ENDPOINT;

const signer = new SignatureV4({
  service: "es",
  region: REGION,
  credentials: defaultProvider(),
  sha256: Sha256,
});

async function signedRequest(method, urlPath, body) {
  const headers = {
    host: DOMAIN_ENDPOINT,
    "Content-Type": "application/json",
  };
  if (body !== undefined) {
    headers["Content-Length"] = Buffer.byteLength(body).toString();
  }
  const req = new HttpRequest({
    method,
    protocol: "https:",
    hostname: DOMAIN_ENDPOINT,
    path: urlPath,
    headers,
    body,
  });
  const signed = await signer.sign(req);
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        method: signed.method,
        hostname: signed.hostname,
        path: signed.path,
        headers: signed.headers,
        port: 443,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ statusCode: res.statusCode, body: data }));
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

exports.handler = async (event) => {
  const props = event.ResourceProperties || {};
  const apiPath = props.Path;
  const body = props.Body;
  const kind = props.Kind;
  const physicalResourceId = kind + ":" + apiPath;

  if (event.RequestType === "Delete") {
    try {
      await signedRequest("DELETE", "/" + apiPath, undefined);
    } catch (err) {
      // Best-effort delete: a missing resource or unreachable domain
      // must not block stack deletion.
      console.log("opensearch_setup_delete_warning", {
        path: apiPath,
        error: err && err.message,
      });
    }
    return { PhysicalResourceId: physicalResourceId };
  }

  const bodyText = JSON.stringify(body);
  let putPath = "/" + apiPath;

  if (kind === "ism_policy") {
    const probe = await signedRequest("GET", "/" + apiPath, undefined);
    if (probe.statusCode === 200) {
      try {
        const parsed = JSON.parse(probe.body);
        const seqNo = parsed._seq_no;
        const primaryTerm = parsed._primary_term;
        if (seqNo !== undefined && primaryTerm !== undefined) {
          putPath =
            "/" + apiPath +
            "?if_seq_no=" + seqNo +
            "&if_primary_term=" + primaryTerm;
        }
      } catch (_) {
        // fall through with bare PUT - treat as a create
      }
    }
  }

  const res = await signedRequest("PUT", putPath, bodyText);
  if (res.statusCode >= 400) {
    throw new Error(
      "OpenSearch PUT " + apiPath + " returned " + res.statusCode + ": " + res.body,
    );
  }
  return {
    PhysicalResourceId: physicalResourceId,
    Data: { statusCode: res.statusCode },
  };
};
`;
