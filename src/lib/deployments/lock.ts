import { withGitMutation } from "@/lib/git/lock";
export function withDeploymentLock(projectId: string, environmentId: string, operation: () => Promise<unknown>) { return withGitMutation(`deployment:${projectId}:${environmentId}`, operation); }
