import { containerName } from "./docker.ts";

export class DeploymentOwnershipError extends Error {
  code = "deployment_not_owned";
  status = 403;
}

export type OwnedContainerRef = { project: { slug: string }; environment: { slug: string }; id: string; containerName: string | null };

// The container name is always recomputed server-side from project slug, environment slug and deployment id.
// A client can never supply a container name, and a stored name that does not match is treated as unowned.
export function ownedContainerName(deployment: OwnedContainerRef) {
  return containerName(deployment.project.slug, deployment.environment.slug, deployment.id);
}

export function assertOwnedContainerName(deployment: OwnedContainerRef) {
  const expected = ownedContainerName(deployment);
  if (!deployment.containerName) throw new DeploymentOwnershipError("This deployment has no owned container.");
  if (deployment.containerName !== expected) throw new DeploymentOwnershipError("Container name does not match the server-generated name for this deployment.");
  return expected;
}

// Server-generated application URL. Only the deployment's own configured port is used,
// and it is offered only when the deployment is actually serving.
export function deploymentAppUrl(deployment: { status: string; environment: { hostPort: number } }) {
  if (!["running", "unhealthy"].includes(deployment.status)) return null;
  return `http://localhost:${deployment.environment.hostPort}/`;
}
