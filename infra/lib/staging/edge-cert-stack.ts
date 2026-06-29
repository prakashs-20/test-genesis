// Route 53 hosted zone (lookup or create) and ACM certificate for the platform apex.
//
// ── Why edge-cert deploys feel slow ─────────────────────────────────────────
// ACM DNS validation has an AWS-side floor of ~5–10 minutes that no CDK
// configuration can shorten:
//
//   1. ACM allocates the random `_<token>.<domain>` validation CNAMEs.
//   2. CDK writes them into the hosted zone (Route 53 propagates in seconds).
//   3. ACM polls **public** DNS for those records on a fixed cadence.
//   4. Cert transitions to ISSUED only after step 3 succeeds.
//
// If the deploy "took a long time" but completed, you hit the unavoidable
// minimum. To skip the wait entirely on subsequent deploys, set
// `envCfg.acmCertificateArn` to a pre-issued cert ARN — this stack will then
// import the existing cert instead of issuing a new one.
//
// ── Automatic DNS validation (when issuing fresh) ───────────────────────────
// Uses `acm.CertificateValidation.fromDnsMultiZone(...)` with every covered
// domain explicitly bound to the same hosted zone. CDK writes the validation
// CNAMEs into the zone; ACM polls until they resolve.
//
// Prerequisites for auto-validation to complete:
//
//   1. `lookup` mode: the Route 53 zone with `hostedZoneName` MUST already
//      exist in the deploying AWS account AND be delegated from the domain
//      registrar (registrar NS records must match the zone's NS).
//
//   2. `create` mode: this stack creates a fresh public hosted zone, and the
//      NS values are emitted as a CfnOutput (`DelegationNsRecords`). They
//      MUST be added as an `NS` record in the *parent* zone before this
//      stack completes — until then ACM cannot resolve the CNAMEs.
//
// Without these, ACM polls up to ~72 hours before failing. The 30-minute
// CFN creation policy added below causes the stack to fail fast instead.

import * as cdk from "aws-cdk-lib";
import {
  CfnOutput,
  Duration,
  aws_route53 as route53,
  aws_certificatemanager as acm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import type { EnvConfig } from "./config.js";

export class EdgeCertStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;
  // Optional — undefined when envCfg.httpsEnabled is false (HTTP-only ALB).
  public readonly certificate?: acm.ICertificate;
  public readonly issuingMode: "imported" | "issued" | "disabled";

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    // ── Hosted zone ────────────────────────────────────────────────────────
    if (envCfg.hostedZoneOwnership === "lookup") {
      this.hostedZone = route53.HostedZone.fromLookup(this, "Zone", {
        domainName: envCfg.hostedZoneName,
      });
    } else {
      const zone = new route53.PublicHostedZone(this, "Zone", {
        zoneName: envCfg.hostedZoneName,
        comment: `axira ${envCfg.name} delegated subzone of axiralabs.ai`,
      });
      this.hostedZone = zone;

      new CfnOutput(this, "DelegationNsRecords", {
        value: cdk.Fn.join(",", zone.hostedZoneNameServers ?? []),
        description:
          "REQUIRED before this stack will reach CREATE_COMPLETE. Add these 4 " +
          `NS values as an NS record at "${envCfg.hostedZoneName}" in the ` +
          "parent zone (axiralabs.ai). Until then ACM DNS validation polls " +
          "indefinitely (capped at the 30-minute creation policy below).",
      });
    }

    // ── Certificate: skip / import / issue ─────────────────────────────────
    if (!envCfg.httpsEnabled) {
      // Skip cert creation entirely. The ALB in ComputeStack falls back to
      // an HTTP-only listener on :80 when no certificate is provided.
      this.issuingMode = "disabled";
    } else if (envCfg.acmCertificateArn) {
      // Fast path — skips ACM validation entirely (instant deploy of this stack).
      this.certificate = acm.Certificate.fromCertificateArn(
        this,
        "Cert",
        envCfg.acmCertificateArn,
      );
      this.issuingMode = "imported";
    } else {
      // Slow path on first deploy (~5–10 min for DNS validation). Subsequent
      // deploys are a no-op because the cert is RETAIN by default.
      const cert = new acm.Certificate(this, "Cert", {
        certificateName: `axira-${envCfg.name}-cert`,
        domainName: envCfg.domainName,
        subjectAlternativeNames: [`*.${envCfg.domainName}`],
        validation: acm.CertificateValidation.fromDnsMultiZone({
          [envCfg.domainName]: this.hostedZone,
          [`*.${envCfg.domainName}`]: this.hostedZone,
        }),
        transparencyLoggingEnabled: true,
      });

      // Cap the stack wait at 30 minutes. A healthy DNS validation finishes
      // well under this; anything longer indicates a delegation/NS problem
      // that won't resolve by waiting — fail fast rather than block for hours.
      const cfn = cert.node.defaultChild as acm.CfnCertificate;
      cfn.cfnOptions.creationPolicy = {
        resourceSignal: { timeout: Duration.minutes(30).toIsoString() },
      };

      this.certificate = cert;
      this.issuingMode = "issued";
    }

    // ── Outputs — make troubleshooting cheap ───────────────────────────────
    if (this.certificate) {
      new CfnOutput(this, "CertificateArn", {
        value: this.certificate.certificateArn,
        description:
          "ACM ARN consumed by the ALB HTTPS listener in axira-staging-compute.",
      });
    }
    new CfnOutput(this, "CertificateDomain", {
      value: envCfg.domainName,
      description:
        "Primary FQDN the certificate covers. Wildcard *.<this> is the only SAN.",
    });
    new CfnOutput(this, "CertificateMode", {
      value: this.issuingMode,
      description:
        "'imported' = pre-existing cert (instant deploy). " +
        "'issued'   = ACM issued a new cert (5–30 min on first deploy).",
    });
    new CfnOutput(this, "HostedZoneId", {
      value: this.hostedZone.hostedZoneId,
    });
    new CfnOutput(this, "HostedZoneName", { value: this.hostedZone.zoneName });
  }
}
