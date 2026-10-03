export const deploymentInProgressStatuses = ["pending", "building", "starting"] as const;

export function hasDeploymentInProgress(statuses: readonly string[]) {
  return statuses.some((status) => deploymentInProgressStatuses.includes(status as (typeof deploymentInProgressStatuses)[number]));
}
