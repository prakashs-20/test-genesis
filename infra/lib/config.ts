export type Environment = "staging" | "production";

export interface EnvironmentConfig {
  env: Environment;
  account: string;
  region: string;
  domainName: string;

  // Network
  vpcCidr: string;
  azCount: number;
  natGateways: number;

  // Database
  rds: {
    instanceClass: string;
    multiAz: boolean;
    allocatedStorage: number;
    maxAllocatedStorage: number;
    backupRetention: number;
    deletionProtection: boolean;
  };

  // Cache
  redis: {
    nodeType: string;
    numCacheNodes: number;
    multiAz: boolean;
    maxMemory: string;
    evictionPolicy: string;
  };

  // Search
  opensearch: {
    dataNodeCount: number;
    dataNodeInstanceType: string;
    masterNodeCount: number;
    masterNodeInstanceType: string;
    ebsVolumeSize: number;
    vectorSearchPlugin: boolean;
  };

  // Logs OpenSearch (Session 2.1 - sibling to `opensearch` above).
  // Optional. Defaults: t3.medium.search × 2 data nodes, single AZ, no
  // master, 100 GB gp3. Production-tier customers may override; staging
  // and production both ship the default tier in v1.
  logsOpensearch?: {
    dataNodeInstanceType?: string;
    dataNodeCount?: number;
    ebsVolumeSize?: number;
  };

  // Storage
  s3: {
    iaTransitionDays: number;
    glacierTransitionDays: number;
    versioning: boolean;
  };

  // Messaging
  messaging: {
    useFifo: boolean;
    visibilityTimeout: number;
    messageRetention: number;
    dlqMaxReceiveCount: number;
  };

  // Temporal
  temporal: {
    serverCount: number;
    cpu: number;
    memory: number;
    dbInstanceClass: string;
  };

  // Compute (4 services in v2)
  compute: {
    services: ServiceScaling[];
  };
}

export interface ServiceScaling {
  name: string;
  cpu: number;
  memory: number;
  minTasks: number;
  maxTasks: number;
  scalingMetric: string;
}

export const stagingConfig: EnvironmentConfig = {
  env: "staging",
  account: process.env.CDK_STAGING_ACCOUNT!,
  region: "us-west-2",
  domainName: "staging.axiralabs.ai",
  vpcCidr: "10.0.0.0/16",
  azCount: 2,
  natGateways: 1,
  rds: {
    instanceClass: "db.r6g.large",
    multiAz: false,
    allocatedStorage: 50,
    maxAllocatedStorage: 200,
    backupRetention: 7,
    deletionProtection: false,
  },
  redis: {
    nodeType: "cache.r6g.large",
    numCacheNodes: 1,
    multiAz: false,
    maxMemory: "256MB",
    evictionPolicy: "allkeys-lru",
  },
  opensearch: {
    dataNodeCount: 2,
    dataNodeInstanceType: "r6g.large.search",
    masterNodeCount: 0,
    masterNodeInstanceType: "",
    ebsVolumeSize: 100,
    vectorSearchPlugin: true,
  },
  s3: {
    iaTransitionDays: 0,
    glacierTransitionDays: 0,
    versioning: true,
  },
  messaging: {
    useFifo: false,
    visibilityTimeout: 300,
    messageRetention: 345600,
    dlqMaxReceiveCount: 3,
  },
  temporal: {
    serverCount: 1,
    cpu: 512,
    memory: 1024,
    dbInstanceClass: "db.t4g.medium",
  },
  compute: {
    services: [
      {
        name: "axira-gateway",
        cpu: 1024,
        memory: 2048,
        minTasks: 1,
        maxTasks: 3,
        scalingMetric: "CPU 70% + request count",
      },
      {
        name: "axira-workflow-engine",
        cpu: 1024,
        memory: 2048,
        minTasks: 1,
        maxTasks: 4,
        scalingMetric: "SQS queue depth + active workflows",
      },
      {
        name: "axira-agent-runtime",
        cpu: 2048,
        memory: 4096,
        minTasks: 1,
        maxTasks: 5,
        scalingMetric: "CPU 70% + agent task queue depth",
      },
      {
        name: "axira-experience",
        cpu: 512,
        memory: 1024,
        minTasks: 1,
        maxTasks: 2,
        scalingMetric: "CPU 70%",
      },
    ],
  },
};

export const productionConfig: EnvironmentConfig = {
  env: "production",
  account: process.env.CDK_PRODUCTION_ACCOUNT!,
  region: "us-west-2",
  domainName: "app.axiralabs.ai",
  vpcCidr: "10.1.0.0/16",
  azCount: 3,
  natGateways: 3,
  rds: {
    instanceClass: "db.r6g.xlarge",
    multiAz: true,
    allocatedStorage: 100,
    maxAllocatedStorage: 1000,
    backupRetention: 30,
    deletionProtection: true,
  },
  redis: {
    nodeType: "cache.r6g.large",
    numCacheNodes: 3,
    multiAz: true,
    maxMemory: "256MB",
    evictionPolicy: "allkeys-lru",
  },
  opensearch: {
    dataNodeCount: 3,
    dataNodeInstanceType: "r6g.large.search",
    masterNodeCount: 3,
    masterNodeInstanceType: "r6g.large.search",
    ebsVolumeSize: 500,
    vectorSearchPlugin: true,
  },
  s3: {
    iaTransitionDays: 90,
    glacierTransitionDays: 365,
    versioning: true,
  },
  messaging: {
    useFifo: true,
    visibilityTimeout: 300,
    messageRetention: 1209600,
    dlqMaxReceiveCount: 5,
  },
  temporal: {
    serverCount: 3,
    cpu: 1024,
    memory: 2048,
    dbInstanceClass: "db.r6g.large",
  },
  compute: {
    services: [
      {
        name: "axira-gateway",
        cpu: 1024,
        memory: 2048,
        minTasks: 2,
        maxTasks: 6,
        scalingMetric: "CPU 70% + request count",
      },
      {
        name: "axira-workflow-engine",
        cpu: 1024,
        memory: 2048,
        minTasks: 2,
        maxTasks: 8,
        scalingMetric: "SQS queue depth + active workflows",
      },
      {
        name: "axira-agent-runtime",
        cpu: 2048,
        memory: 4096,
        minTasks: 2,
        maxTasks: 10,
        scalingMetric: "CPU 70% + agent task queue depth",
      },
      {
        name: "axira-experience",
        cpu: 512,
        memory: 1024,
        minTasks: 2,
        maxTasks: 4,
        scalingMetric: "CPU 70%",
      },
    ],
  },
};

export function getConfig(env: Environment): EnvironmentConfig {
  return env === "production" ? productionConfig : stagingConfig;
}
