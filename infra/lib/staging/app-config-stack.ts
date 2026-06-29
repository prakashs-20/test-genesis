// AWS AppConfig: Application + Environment + Hosted Feature Flag profile + a
// canary-style deployment strategy. ECS task roles (granted in ComputeStack) call
// StartConfigurationSession + GetLatestConfiguration against these IDs.

import * as cdk from "aws-cdk-lib";
import { CfnOutput, aws_appconfig as appconfig } from "aws-cdk-lib";
import { Construct } from "constructs";

import { isProdEnv } from "./config.js";
import type { EnvConfig } from "./config.js";

export class AppConfigStack extends cdk.Stack {
  public readonly applicationId: string;
  public readonly environmentId: string;
  public readonly featureFlagsProfileId: string;
  public readonly deploymentStrategyId: string;

  constructor(
    scope: Construct,
    id: string,
    envCfg: EnvConfig,
    props: cdk.StackProps,
  ) {
    super(scope, id, props);

    const application = new appconfig.CfnApplication(this, "Application", {
      name: `axira-${envCfg.name}`,
      description: `Axira platform feature flags for ${envCfg.name}`,
    });
    this.applicationId = application.ref;

    const environment = new appconfig.CfnEnvironment(this, "Environment", {
      applicationId: application.ref,
      name: envCfg.name,
      description: `Axira ${envCfg.name} runtime environment`,
    });
    this.environmentId = environment.ref;

    const featureFlagsProfile = new appconfig.CfnConfigurationProfile(
      this,
      "FeatureFlagsProfile",
      {
        applicationId: application.ref,
        name: "feature-flags",
        locationUri: "hosted",
        type: "AWS.AppConfig.FeatureFlags",
        description: "Runtime feature flags evaluated by every Axira service",
      },
    );
    this.featureFlagsProfileId = featureFlagsProfile.ref;

    const isProd = isProdEnv(envCfg.name);
    const deploymentStrategy = new appconfig.CfnDeploymentStrategy(
      this,
      "DeploymentStrategy",
      {
        name: `axira-${envCfg.name}-linear`,
        deploymentDurationInMinutes: isProd ? 20 : 2,
        growthFactor: isProd ? 25 : 50,
        growthType: "LINEAR",
        finalBakeTimeInMinutes: isProd ? 10 : 1,
        replicateTo: "NONE",
        description: `Axira ${envCfg.name} linear feature-flag rollout`,
      },
    );
    this.deploymentStrategyId = deploymentStrategy.ref;

    new CfnOutput(this, "ApplicationId", { value: this.applicationId });
    new CfnOutput(this, "EnvironmentId", { value: this.environmentId });
    new CfnOutput(this, "FeatureFlagsProfileId", {
      value: this.featureFlagsProfileId,
    });
    new CfnOutput(this, "DeploymentStrategyId", {
      value: this.deploymentStrategyId,
    });
  }
}
