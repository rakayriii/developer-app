import { prisma } from "@/lib/db";
import { deploymentRepositoryReference, validateEnvironmentInput, environmentTypes, type EnvironmentType } from "./config.ts";
import { EnvironmentTargetError, localPortScope, remotePortScope, resolveTargetInput, type DeploymentTargetName } from "./target-scope.ts";

export { localPortScope, remotePortScope, isDeploymentTarget, resolveTargetInput, portScopeFor, EnvironmentTargetError, type DeploymentTargetName } from "./target-scope.ts";
export { validateEnvironmentInput, environmentTypes, deploymentRepositoryReference };
export type { EnvironmentType };

/**
 * Validates the deployment target of an environment and resolves it against the user's servers.
 *
 * The shape rules live in target-scope.ts; this function adds the ownership and capability checks that
 * require a database. A remote environment may only reference a registered Server owned by the same
 * user: the hostname, port, username, and credential are read from that record at deploy time, and the
 * browser supplies nothing but the server id.
 */
export async function validateEnvironmentTarget(userId: string, body: Record<string, unknown>): Promise<{ target: DeploymentTargetName; serverId: string | null; portScopeKey: string }> {
  const { target, serverId } = resolveTargetInput(body);

  if (target === "local") return { target, serverId: null, portScopeKey: localPortScope };

  const server = await prisma.server.findFirst({ where: { id: serverId as string, userId }, select: { id: true, status: true, dockerAvailable: true, name: true } });
  // Another user's server is reported as missing rather than forbidden, so ownership cannot be probed.
  if (!server) throw new EnvironmentTargetError("The selected server was not found.");
  if (server.status !== "online") throw new EnvironmentTargetError(`${server.name} is not online. Refresh it before targeting it.`);
  if (!server.dockerAvailable) throw new EnvironmentTargetError(`${server.name} does not have a usable Docker daemon.`);
  return { target, serverId: server.id, portScopeKey: remotePortScope(server.id) };
}

/** Host ports are unique per Docker host, so a conflict is only a conflict within the same scope. */
export async function assertPortScopeAvailable(portScopeKey: string, hostPort: number, excludeEnvironmentId?: string) {
  return prisma.deploymentEnvironment.findFirst({ where: { portScopeKey, hostPort, ...(excludeEnvironmentId ? { id: { not: excludeEnvironmentId } } : {}) } });
}

