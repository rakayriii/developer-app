import type { ContainerRuntime, HealthCheckResult } from "./docker.ts";
import { buildImage, containerDiagnostics, containerExists, containerRuntime, execReleaseCommand, healthCheck, imageExists, portAvailable, restartOwnedContainer, startContainer, stopOwnedContainer, verifyOwnedContainer } from "./docker.ts";
import { containerName, localDaemonArchitecture } from "./docker.ts";
import { prisma } from "@/lib/db";
import { openRemoteDeployment, RemoteDeploymentError } from "./remote/server.ts";
import { remoteDeploymentOps } from "./remote-target.ts";
import type { DeploymentOps, StageLogger, StartRequest, TargetBinding } from "./target-types.ts";

export type { DeploymentOps, StageLogger, StartRequest, TargetBinding, HostPortRequest } from "./target-types.ts";

/** Bounded failure evidence, captured before any cleanup so it survives the cleanup. */
async function captureLocalDiagnostics(deploymentId: string, containerId: string, stageLog: StageLogger, secretValues: readonly string[]) {
  const diagnostics = await containerDiagnostics(containerId).catch(() => ({ state: "unknown", logs: "" }));
  await stageLog(deploymentId, "runtime", `Container state: ${diagnostics.state}`, secretValues);
  if (diagnostics.logs) await stageLog(deploymentId, "runtime", `Container logs (tail):\n${diagnostics.logs}`, secretValues);
}

/**
 * A host port can only be bound once on the local Docker host, so an incumbent owned container must be
 * released before a replacement can start. Only containers recorded for this environment whose name
 * matches the server-generated pattern are ever touched, and their logs are captured first.
 */
async function releaseLocalHostPort(environmentId: string, excludeDeploymentId: string, stageLog: StageLogger, secretValues: readonly string[]) {
  const incumbents = await prisma.deployment.findMany({
    where: { environmentId, id: { not: excludeDeploymentId }, status: { in: ["running", "unhealthy", "starting"] }, containerId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, containerName: true, containerId: true },
  });
  for (const incumbent of incumbents) {
    if (!incumbent.containerName || !incumbent.containerId) continue;
    if (!incumbent.containerName.startsWith("developer-os-")) continue;
    if (!(await verifyOwnedContainer(incumbent.containerName))) continue;
    await captureLocalDiagnostics(incumbent.id, incumbent.containerId, stageLog, secretValues);
    await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopping", lastStage: "stopping", finishedAt: new Date(), stopReason: "replaced" } }).catch(() => undefined);
    await stopOwnedContainer(incumbent.containerId);
    await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopped", lastStage: "stopping", stopReason: "replaced" } }).catch(() => undefined);
    await stageLog(incumbent.id, "stop", `Container ${incumbent.containerName} released the host port for a replacement deployment.`, secretValues);
  }
}

/** The Phase 8/9 local Docker implementation, built from the existing primitives. */
async function localDeploymentOps(stageLog: StageLogger): Promise<DeploymentOps> {
  return {
    target: "local",
    serverId: null,
    serverName: null,
    targetArchitecture: await localDaemonArchitecture(),
    releaseHostPort: ({ environmentId, excludeDeploymentId }, secretValues) => releaseLocalHostPort(environmentId, excludeDeploymentId, stageLog, secretValues),
    // A local build already produced the image on this host, so there is nothing to transfer.
    transferImage: async () => undefined,
    start: async (request: StartRequest) => {
      const name = containerName(request.projectSlug, request.environmentSlug, request.deploymentId);
      const containerId = await startContainer({ tag: request.tag, name, hostPort: request.hostPort, containerPort: request.containerPort, cpuLimit: request.cpuLimit, memoryLimit: request.memoryLimit, environment: request.variables });
      return { containerId, containerName: name };
    },
    runRelease: async (containerId: string) => { await execReleaseCommand(containerId, "migrate", (chunk) => { void stageLog("", "release_command", chunk); }); },
    verifyHealth: (hostPort, healthPath, timeoutMs, retries): Promise<HealthCheckResult> => healthCheck(hostPort, healthPath, timeoutMs, retries),
    captureDiagnostics: (deploymentId, containerId) => captureLocalDiagnostics(deploymentId, containerId, stageLog, []),
    stopContainer: async (containerId) => { await stopOwnedContainer(containerId); },
    restartContainer: async (containerId) => { await restartOwnedContainer(containerId); },
    containerExists: async (containerId) => containerExists(containerId),
    runtime: async (containerId): Promise<ContainerRuntime | null> => containerRuntime(containerId),
    verifyRollbackImage: async (tag) => imageExists(tag),
    close: async () => undefined,
  };
}

/**
 * Resolves the operation set for a deployment's target.
 *
 * For a remote target every precondition is enforced here, before the caller can build or transfer
 * anything: server ownership, host-key trust and fingerprint consistency, online status, Docker
 * availability, a live SSH handshake with the pinned host key, and the remote capability probes.
 */
export async function resolveDeploymentOps(deployment: TargetBinding, stageLog: StageLogger): Promise<DeploymentOps> {
  if (deployment.target !== "remote") return await localDeploymentOps(stageLog);
  const serverId = deployment.serverId ?? deployment.environment.serverId;
  if (!serverId) throw new RemoteDeploymentError("server_not_found", "This remote deployment is not bound to a server.", 409);
  const context = await openRemoteDeployment(deployment.project.userId, serverId);
  return remoteDeploymentOps(deployment.id, context, stageLog);
}

export { portAvailable, verifyOwnedContainer, buildImage };
