// Cross-stack reference shapes passed between staging stacks.

import type {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_servicediscovery as servicediscovery,
} from "aws-cdk-lib";

export interface SharedProps {
  readonly vpc: ec2.IVpc;
  readonly cluster?: ecs.ICluster;
  readonly serviceSg?: ec2.ISecurityGroup;
  readonly albSg?: ec2.ISecurityGroup;
  readonly dbSg?: ec2.ISecurityGroup;
  readonly cacheSg?: ec2.ISecurityGroup;
  readonly searchSg?: ec2.ISecurityGroup;
  // SG attached to Secrets Manager hosted-rotation Lambdas. Owned by NetworkStack
  // so dbSg can grant ingress to it without creating a Database→Network edge.
  readonly dbRotationSg?: ec2.ISecurityGroup;
  // SG attached to the cloudflared tunnel connector (private-access model).
  // Owned by NetworkStack so albSg can grant it ingress intra-stack; the
  // connector itself (CloudflaredStack) consumes it. Outbound-only — the
  // connector dials Cloudflare; nothing dials in.
  readonly cloudflaredSg?: ec2.ISecurityGroup;
  readonly serviceDiscoveryNamespace?: servicediscovery.IPrivateDnsNamespace;
}
