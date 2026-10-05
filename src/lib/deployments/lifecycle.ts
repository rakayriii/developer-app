export const deploymentStatuses = ["pending", "building", "starting", "running", "unhealthy", "stopping", "stopped", "failed", "rolled_back"] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

// Only these transitions are legal. Anything else is a bug or a hostile request and is rejected server-side.
const allowed: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = Object.freeze({
  pending: ["building", "starting", "failed", "stopped"],
  building: ["starting", "failed"],
  starting: ["running", "unhealthy", "failed"],
  running: ["stopping", "unhealthy"],
  unhealthy: ["stopping", "failed"],
  stopping: ["stopped", "failed"],
  stopped: ["starting", "pending"],
  failed: ["pending", "stopped"],
  rolled_back: [],
});

export class DeploymentTransitionError extends Error {
  code = "invalid_deployment_transition";
  status = 409;
}

export function isDeploymentStatus(value: unknown): value is DeploymentStatus {
  return typeof value === "string" && deploymentStatuses.includes(value as DeploymentStatus);
}

export function canTransition(from: string, to: string) {
  if (!isDeploymentStatus(from) || !isDeploymentStatus(to)) return false;
  return allowed[from].includes(to);
}

export function assertTransition(from: string, to: string) {
  if (!canTransition(from, to)) throw new DeploymentTransitionError(`Deployment cannot move from ${from} to ${to}.`);
}

export function allowedTransitions(from: string): readonly DeploymentStatus[] {
  return isDeploymentStatus(from) ? allowed[from] : [];
}
