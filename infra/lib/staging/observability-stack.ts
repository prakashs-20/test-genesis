// axira-logs OpenSearch domain, ISM policies, index templates, dedicated observability ECS cluster, ADOT Collector Fargate service.

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
import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";
import type { SharedProps } from "./types.js";
import type { SecretsStack } from "./secrets-stack.js";
import {
  OtelCollectorConstruct,
  OTEL_COLLECTOR_NAMESPACE_NAME,
  OTEL_COLLECTOR_OTLP_HTTP_PORT,
  OTEL_COLLECTOR_SERVICE_NAME,
} from "./observability/otel-collector-construct.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// AWS OpenSearch domain names are capped at 28 characters. The canonical
// `axira-logs-<env>` name fits every env up to and including `axira-los-staging`
// (28 chars exactly), so for those it is returned UNCHANGED — keeping the logs
// domain (and thus the synthesized template) byte-for-byte identical. The only
// env whose canonical name overflows is `genesis-prod-staging`
// (`axira-logs-genesis-prod-staging` = 31), so it falls back to a deterministic,
// readable short name within the limit. Any future over-long env name gets a
// stable truncation that still starts `axira-logs-`.
function logsDomainName(envName: string): string {
  const canonical = `axira-logs-${envName}`;
  if (canonical.length <= 28) return canonical;
  if (envName === "genesis-prod-staging") return "axira-logs-genesis-pstg";
  return canonical.slice(0, 28);
}

export class ObservabilityStack extends cdk.Stack {
  public readonly logsDomain: opensearch.Domain;
  public readonly logsDomainEndpoint: string;
  public readonly observabilityCluster: ecs.Cluster;
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;
  // OtelCollector is optional — disabled by default until the ADOT pipeline
  // YAML is verified against the actual aws-otel-collector image version
  // and the OpenSearch exporter syntax is finalized for the deployed
  // distro. Services log to CloudWatch unaffected; OTLP traces are not
  // forwarded when this is undefined.
  public readonly otelCollector?: OtelCollectorConstruct;
  public readonly otelCollectorEndpoint: string;
  public readonly otelCollectorSecurityGroupId: string;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    shared: SharedProps,
    secrets: SecretsStack,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const vpc = shared.vpc;
    const ecsSecurityGroup = shared.serviceSg!;
    const sizing = envCfg.logsOpenSearch;

    const logsSecurityGroup = new ec2.SecurityGroup(
      this,
      "AxiraLogsSecurityGroup",
      {
        vpc,
        securityGroupName: `axira-${envCfg.name}-logs-sg`,
        description: "axira-logs OpenSearch accepts ECS and setup Lambda",
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
        securityGroupName: `axira-${envCfg.name}-logs-setup-sg`,
        description: "axira-logs setup Lambda egress 443 to domain",
        allowAllOutbound: true,
      },
    );
    logsSecurityGroup.addIngressRule(
      setupLambdaSecurityGroup,
      ec2.Port.tcp(443),
      "setup Lambda to axira-logs",
    );

    this.logsDomain = new opensearch.Domain(this, "AxiraLogs", {
      domainName: logsDomainName(envCfg.name),
      version: opensearch.EngineVersion.OPENSEARCH_2_17,
      capacity: {
        dataNodeInstanceType: sizing.dataNodeInstanceType,
        dataNodes: sizing.dataNodeCount,
      },
      ebs: {
        volumeSize: sizing.ebsVolumeGiB,
        volumeType: ec2.EbsDeviceVolumeType.GP3,
      },
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      securityGroups: [logsSecurityGroup],
      // Subnet count must match the AZ topology: with N data nodes spread
      // across N subnets, zone awareness must be enabled. Without it
      // OpenSearch insists on exactly one subnet and rejects multi-subnet
      // selectors. Fall back to enabled=false only when there's a single
      // data node (single-AZ deployment).
      zoneAwareness:
        sizing.dataNodeCount > 1
          ? {
              enabled: true,
              availabilityZoneCount: Math.min(sizing.dataNodeCount, 3),
            }
          : { enabled: false },
      nodeToNodeEncryption: true,
      encryptionAtRest: { enabled: true, kmsKey: secrets.appKey },
      enforceHttps: true,
      removalPolicy: isProdEnv(envCfg.name)
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });
    this.logsDomainEndpoint = `https://${this.logsDomain.domainEndpoint}`;

    // Domain-level resource (access) policy. Without one, a VPC OpenSearch
    // domain applies a restrictive default that denies EVERY request — incl.
    // IAM-signed — with "User: anonymous is not authorized to perform:
    // es:ESHttpPost because no resource-based policy allows the es:ESHttpPost
    // action". The gateway observability routes (logs/traces/app-ops/
    // dashboards/alerts) + the timeline logs/traces sources query this LOGS
    // domain over the private subnet and do NOT SigV4-sign (the cluster client
    // speaks raw HTTP; AWS-fronted auth would ride an Authorization header,
    // which is unset in-VPC). The setup Lambda above signs (it injects the
    // logs/traces index templates + ISM policies), so the policy must admit
    // BOTH the anonymous in-VPC callers AND the Lambda's signed calls — an
    // open-in-VPC anonymous allow of es:ESHttp* on domain/<name>/* covers
    // both. Reachability is gated by the logs security group (admits only the
    // ECS service SG + the setup Lambda SG), not by IAM. Parameterized via the
    // domain ARN so every env (incl. genesis-prod) gets the identical policy.
    this.logsDomain.addAccessPolicies(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ["es:ESHttp*"],
        resources: [`${this.logsDomain.domainArn}/*`],
      }),
    );

    const setupLambda = new lambda.Function(this, "AxiraLogsSetupLambda", {
      functionName: `axira-${envCfg.name}-logs-setup`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [setupLambdaSecurityGroup],
      environment: { DOMAIN_ENDPOINT: this.logsDomain.domainEndpoint },
      code: lambda.Code.fromInline(SETUP_LAMBDA_SOURCE),
      // Note: we deliberately do NOT set reservedConcurrentExecutions here.
      // Reserving even 1 slot would drop the account's unreserved-pool below
      // AWS's hard minimum of 10. Instead, the 4 OpenSearch custom resources
      // are chained via CDK dependencies below so they fire serially against
      // this Lambda — no concurrency reservation needed.
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

    // Chain the 4 custom resources so they invoke the setup Lambda one at a
    // time. Without this, CFN fires them in parallel, hitting Lambda burst
    // limits (TooManyRequestsException) on cold start with a VPC-bound
    // function. We can't use reservedConcurrentExecutions to serialize
    // because the account's unreserved-pool is too tight.
    const r1 = this.applyOpensearchResource(
      provider,
      "LogsIndexTemplate",
      "index_template",
      "_index_template/axira-logs",
      logsTemplate,
    );
    const r2 = this.applyOpensearchResource(
      provider,
      "TracesIndexTemplate",
      "index_template",
      "_index_template/axira-traces",
      tracesTemplate,
    );
    const r3 = this.applyOpensearchResource(
      provider,
      "LogsIsmPolicy",
      "ism_policy",
      "_plugins/_ism/policies/axira-logs-15d",
      logsPolicy,
    );
    const r4 = this.applyOpensearchResource(
      provider,
      "TracesIsmPolicy",
      "ism_policy",
      "_plugins/_ism/policies/axira-traces-14d",
      tracesPolicy,
    );
    r2.node.addDependency(r1);
    r3.node.addDependency(r2);
    r4.node.addDependency(r3);

    this.observabilityCluster = new ecs.Cluster(this, "ObservabilityCluster", {
      clusterName: `axira-${envCfg.name}-observability`,
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "CloudMapNamespace",
      {
        name: OTEL_COLLECTOR_NAMESPACE_NAME,
        vpc,
        description:
          "Axira observability data-plane DNS namespace. Resolves otel-collector.axira.local in-VPC.",
      },
    );

    // OtelCollector is disabled by default — the ADOT pipeline YAML uses
    // features (OpenSearch exporter index templating, OTTL filter syntax)
    // that aren't guaranteed in the deployed aws-otel-collector image
    // version, which causes the container to exit code 1 immediately and
    // trip the ECS deployment circuit breaker. Until the config is
    // verified against the actual image, leave this off.
    //
    // To re-enable once the config is verified, set OTEL_COLLECTOR_ENABLED=1
    // before running cdk deploy/synth, OR flip the literal below.
    const otelCollectorEnabled = process.env.OTEL_COLLECTOR_ENABLED === "1";

    if (otelCollectorEnabled) {
      this.otelCollector = new OtelCollectorConstruct(this, "OtelCollector", {
        vpc,
        ecsSecurityGroup,
        cluster: this.observabilityCluster,
        cloudMapNamespace: this.cloudMapNamespace,
        logsDomain: this.logsDomain,
        environmentName: envCfg.name,
        clusterName: envCfg.name,
        phoenixEndpoint: envCfg.phoenixEndpoint,
      });
      this.otelCollectorEndpoint = `http://${OTEL_COLLECTOR_SERVICE_NAME}.${OTEL_COLLECTOR_NAMESPACE_NAME}:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`;
      this.otelCollectorSecurityGroupId =
        this.otelCollector.securityGroup.securityGroupId;
    } else {
      // Stub values consumed by compute-stack as OTEL_EXPORTER_OTLP_ENDPOINT
      // env var. Apps that emit OTLP will fail to connect — that's intended;
      // they'll still log to CloudWatch normally. Use a clearly-invalid URL
      // so app-side libraries fail fast rather than silently buffer.
      this.otelCollectorEndpoint = "http://otel-disabled.axira.local:4318";
      this.otelCollectorSecurityGroupId = "";
    }

    new cdk.CfnOutput(this, "LogsDomainEndpoint", {
      value: this.logsDomainEndpoint,
    });
    new cdk.CfnOutput(this, "OtelCollectorEndpoint", {
      value: this.otelCollectorEndpoint,
    });
  }

  private applyOpensearchResource(
    provider: cr.Provider,
    id: string,
    kind: "index_template" | "ism_policy",
    apiPath: string,
    body: unknown,
  ): cdk.CustomResource {
    const resource = new cdk.CustomResource(this, id, {
      serviceToken: provider.serviceToken,
      properties: { Path: apiPath, Body: body, Kind: kind },
    });
    resource.node.addDependency(this.logsDomain);
    return resource;
  }
}

// Lambda Node.js 22 runtime no longer ships the AWS SDK pre-installed
// (the v3 packages were bundled into Node 18/20 runtimes but removed
// starting Node 22). To avoid having to bundle the Lambda we implement
// AWS SigV4 by hand with Node built-ins only — node:https for transport
// and node:crypto for HMAC/SHA256. The function takes Lambda execution
// role credentials from the environment variables AWS automatically
// injects.
const SETUP_LAMBDA_SOURCE = `
const https = require("node:https");
const crypto = require("node:crypto");

const REGION = process.env.AWS_REGION;
const DOMAIN_ENDPOINT = process.env.DOMAIN_ENDPOINT;
const SERVICE = "es";

function sha256Hex(payload) {
  return crypto.createHash("sha256").update(payload || "").digest("hex");
}
function hmac(key, str) {
  return crypto.createHmac("sha256", key).update(str).digest();
}

function credentials() {
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

function buildCanonicalHeaders(headers) {
  const sortedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lowerHeaders = {};
  for (const k of Object.keys(headers)) lowerHeaders[k.toLowerCase()] = String(headers[k]).trim().replace(/\\s+/g, " ");
  const canonical = sortedKeys.map((k) => k + ":" + lowerHeaders[k] + "\\n").join("");
  const signed = sortedKeys.join(";");
  return { canonical, signed };
}

function urlencodeQuery(qs) {
  if (!qs) return "";
  const parts = qs.split("&").filter(Boolean).map((kv) => {
    const eq = kv.indexOf("=");
    const k = eq === -1 ? kv : kv.slice(0, eq);
    const v = eq === -1 ? "" : kv.slice(eq + 1);
    return encodeURIComponent(decodeURIComponent(k)) + "=" + encodeURIComponent(decodeURIComponent(v));
  });
  parts.sort();
  return parts.join("&");
}

function signRequest(method, urlPath, body, extraHeaders) {
  const creds = credentials();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\\-]|\\.\\d{3}/g, ""); // 20231231T235959Z
  const dateStamp = amzDate.slice(0, 8);

  const [pathOnly, queryOnly] = urlPath.split("?", 2);
  const canonicalPath = pathOnly;
  const canonicalQuery = urlencodeQuery(queryOnly || "");
  const payload = body === undefined ? "" : body;
  const payloadHash = sha256Hex(payload);

  const headers = {
    host: DOMAIN_ENDPOINT,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    ...(extraHeaders || {}),
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const { canonical: canonicalHeaders, signed: signedHeaders } = buildCanonicalHeaders(headers);

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\\n");

  const credentialScope = dateStamp + "/" + REGION + "/" + SERVICE + "/aws4_request";
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\\n");

  const kDate = hmac("AWS4" + creds.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers["authorization"] =
    "AWS4-HMAC-SHA256 Credential=" + creds.accessKeyId + "/" + credentialScope +
    ", SignedHeaders=" + signedHeaders +
    ", Signature=" + signature;

  return headers;
}

async function signedRequest(method, urlPath, body) {
  const extra = body !== undefined
    ? { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() }
    : {};
  const headers = signRequest(method, urlPath, body, extra);
  return new Promise((resolve, reject) => {
    const r = https.request(
      { method, hostname: DOMAIN_ENDPOINT, path: urlPath, headers, port: 443 },
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
    try { await signedRequest("DELETE", "/" + apiPath, undefined); }
    catch (err) { console.log("opensearch_setup_delete_warning", { path: apiPath, error: err && err.message }); }
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
          putPath = "/" + apiPath + "?if_seq_no=" + seqNo + "&if_primary_term=" + primaryTerm;
        }
      } catch (_) { }
    }
  }

  const res = await signedRequest("PUT", putPath, bodyText);
  if (res.statusCode >= 400) {
    throw new Error("OpenSearch PUT " + apiPath + " returned " + res.statusCode + ": " + res.body);
  }
  return { PhysicalResourceId: physicalResourceId, Data: { statusCode: res.statusCode } };
};
`;
