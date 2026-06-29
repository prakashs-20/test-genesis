import type { EnvironmentConfig } from "./config.js";

/**
 * Customer IaC config overlay for customer-hosted deployments.
 * Customers provide their own values; defaults come from stagingConfig/productionConfig.
 */
export interface CustomerConfig {
  tenant: {
    name: string;
    id: string;
  };

  aws: {
    accountId: string;
    region: string;
    vpcId?: string;
    privateSubnets?: string[];
    publicSubnets?: string[];
  };

  dns: {
    production: string;
    staging: string;
    dev: string;
    certificateArn: string;
  };

  auth: {
    auth0Domain: string;
    auth0ClientId: string;
    auth0ClientSecretArn: string;
  };

  secrets: {
    prefix: string;
  };

  database?: {
    instanceClass?: string;
    multiAz?: boolean;
    backupRetentionDays?: number;
  };

  services?: {
    "axira-gateway"?: {
      cpu?: number;
      memory?: number;
      min?: number;
      max?: number;
    };
    "axira-workflow-engine"?: {
      cpu?: number;
      memory?: number;
      min?: number;
      max?: number;
    };
    "axira-agent-runtime"?: {
      cpu?: number;
      memory?: number;
      min?: number;
      max?: number;
    };
    "axira-experience"?: {
      cpu?: number;
      memory?: number;
      min?: number;
      max?: number;
    };
  };

  products: {
    lending: boolean;
    compliance: boolean;
  };

  dataResidency: {
    primaryRegion: string;
    drRegion?: string;
    geoRestriction?: string[];
  };
}

/**
 * Merge customer config into an EnvironmentConfig.
 * Customer overrides take precedence over defaults.
 */
export function mergeCustomerConfig(
  base: EnvironmentConfig,
  customer: CustomerConfig,
): EnvironmentConfig {
  return {
    ...base,
    account: customer.aws.accountId,
    region: customer.aws.region,
    domainName: customer.dns.production,

    rds: {
      ...base.rds,
      ...(customer.database?.instanceClass && {
        instanceClass: customer.database.instanceClass,
      }),
      ...(customer.database?.multiAz !== undefined && {
        multiAz: customer.database.multiAz,
      }),
      ...(customer.database?.backupRetentionDays && {
        backupRetention: customer.database.backupRetentionDays,
      }),
    },

    compute: {
      services: base.compute.services.map((svc) => {
        const override =
          customer.services?.[svc.name as keyof typeof customer.services];
        if (!override) return svc;
        return {
          ...svc,
          ...(override.cpu && { cpu: override.cpu }),
          ...(override.memory && { memory: override.memory }),
          ...(override.min && { minTasks: override.min }),
          ...(override.max && { maxTasks: override.max }),
        };
      }),
    },
  };
}
