// Pure deployment-target rules. Deliberately free of any database or Next.js import so the rules can be
// unit tested without standing up Prisma, and so `target.ts` is left owning only the ownership lookup.

export const localPortScope = "local";
export const remotePortScope = (serverId: string) => `server:${serverId}`;

export type DeploymentTargetName = "local" | "remote";

export class EnvironmentTargetError extends Error {
  code = "invalid_deployment_target";
  status = 400;
}

export function isDeploymentTarget(value: unknown): value is DeploymentTargetName {
  return value === "local" || value === "remote";
}

/**
 * Validates the shape of a deployment target without touching the database.
 *
 * A local environment must not carry a server, and a remote one must name exactly one. This makes a
 * record unambiguous about where it runs before any lookup happens, and it is the reason a hostname can
 * never be supplied at deploy time: there is no field for one.
 */
export function resolveTargetInput(body: Record<string, unknown>): { target: DeploymentTargetName; serverId: string | null } {
  const raw = body.target === undefined ? "local" : body.target;
  if (!isDeploymentTarget(raw)) throw new EnvironmentTargetError("Deployment target must be local or remote.");

  if (raw === "local") {
    if (body.serverId !== undefined && body.serverId !== null) throw new EnvironmentTargetError("A local environment cannot reference a remote server.");
    return { target: "local", serverId: null };
  }

  if (typeof body.serverId !== "string" || !body.serverId.trim()) throw new EnvironmentTargetError("Select a registered server for a remote environment.");
  return { target: "remote", serverId: body.serverId.trim() };
}

/** Host ports are unique per Docker host, not globally. */
export function portScopeFor(target: DeploymentTargetName, serverId: string | null) {
  return target === "remote" && serverId ? remotePortScope(serverId) : localPortScope;
}
