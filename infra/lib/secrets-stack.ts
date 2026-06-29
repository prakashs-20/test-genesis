import * as cdk from "aws-cdk-lib";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { EnvironmentConfig } from "./config.js";

export class SecretsStack extends cdk.Stack {
  public readonly secrets: Record<string, secretsmanager.Secret>;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    props?: cdk.StackProps,
  ) {
    super(scope, id, props);

    this.secrets = {};

    // Integration API keys are product-scoped in Secrets Manager.
    // Lending product keys and Compliance product keys are loaded per tenant's active products.
    // Platform-wide keys (AI models, auth) are shared across all products.
    const secretNames = [
      // Platform-wide
      "DATABASE_URL",
      "AUTH0_DOMAIN",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_M2M_CLIENT_ID",
      "AUTH0_M2M_CLIENT_SECRET",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      // Lending product integrations
      "DOCUSIGN_API_KEY",
      "SALESFORCE_CLIENT_ID",
      "SALESFORCE_CLIENT_SECRET",
      "COSTAR_API_KEY",
      "CORELOGIC_API_KEY",
      "FCI_API_KEY",
      "TRUSTPOINT_API_KEY",
      "SAGE_API_KEY",
      // Compliance product integrations
      "OFAC_API_KEY",
      "REFINITIV_API_KEY",
      "COMPLYADVANTAGE_API_KEY",
    ];

    for (const name of secretNames) {
      this.secrets[name] = new secretsmanager.Secret(this, name, {
        secretName: `axira/${config.env}/${name.toLowerCase().replace(/_/g, "-")}`,
        description: `Axira ${config.env} - ${name}`,
      });
    }
  }
}
