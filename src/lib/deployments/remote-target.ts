import { prisma } from "@/lib/db";
import type { ContainerRuntime, HealthCheckResult } from "./docker.ts";
import { containerName } from "./docker.ts";
import { RemoteDeploymentError, type RemoteDeploymentContext } from "./remote/server.ts";
import {
  remoteContainerDiagnostics,
  remoteContainerExists,
  remoteContainerRuntime,
  remoteDockerCreate,
  remoteDockerExecMigration,
  remoteDockerImageExists,
  remoteDockerLoad,
  remoteDockerRemove,
  remoteDockerRestart,
  remoteDockerStart,
  remoteDockerStop,
  remoteHealthCheck,
  remotePortOwner,
  remoteRemoveEnvironmentFile,
  remoteWriteEnvironmentFile,
} from "./remote/docker.ts";
import { remoteCreateCommand } from "./remote/args.ts";
import { remoteEnvironmentFilePath, renderEnvironmentFile } from "./remote/env-file.ts";
import type { DeploymentOps, StageLogger, StartRequest } from "./target-types.ts";


/** The Phase 8/9 local Docker implementation of the operation set. Reuses the existing primitives. */
/** The Phase 11 remote implementation of the operation set. Reuses the same contract as the local one. */
export function remoteDeploymentOps(deploymentId: string, context: RemoteDeploymentContext, stageLog: StageLogger): DeploymentOps {
  const { transport, server } = context;
  const existsByName = (name: string) => remoteContainerExists(transport, name);

  const transferImage = async (tag: string, secretValues: readonly string[]) => {
    await stageLog(deploymentId, "transfer", `Streaming image ${tag} to ${server.name}. No public registry is involved.`, secretValues);
    let lastReported = 0;
    const result = await remoteDockerLoad(transport, tag, (bytes) => {
      // Progress is reported coarsely; per-chunk logging would flood the deployment log.
      if (bytes - lastReported < 32 * 1024 * 1024) return;
      lastReported = bytes;
      void stageLog(deploymentId, "transfer", `Transferred ${(bytes / (1024 * 1024)).toFixed(0)} MB so far.`, secretValues);
    });
    await stageLog(deploymentId, "transfer", `Transfer completed: ${(result.bytes / (1024 * 1024)).toFixed(1)} MB written to the remote Docker daemon.`, secretValues);
    await prisma.deployment.update({ where: { id: deploymentId }, data: { transferCompletedAt: new Date(), transferBytes: BigInt(result.bytes) } }).catch(() => undefined);
  };

  return {
    target: "remote",
    serverId: server.id,
    serverName: server.name,

    releaseHostPort: async ({ environmentId, excludeDeploymentId, hostPort }, secretValues) => {
      // A host port binds once per Docker host. Incumbents recorded against *this* server are ours and
      // may be released; anything else holding the port is left strictly alone.
      const incumbents = await prisma.deployment.findMany({
        where: { environmentId, id: { not: excludeDeploymentId }, serverId: server.id, status: { in: ["running", "unhealthy", "starting"] }, containerName: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { id: true, containerName: true },
      });
      for (const incumbent of incumbents) {
        if (!incumbent.containerName || !incumbent.containerName.startsWith("developer-os-")) continue;
        if (!(await existsByName(incumbent.containerName))) continue;
        const diagnostics = await remoteContainerDiagnostics(transport, incumbent.containerName);
        await stageLog(incumbent.id, "runtime", `Container state: ${diagnostics.state}`, secretValues);
        if (diagnostics.logs) await stageLog(incumbent.id, "runtime", `Container logs (tail):\n${diagnostics.logs}`, secretValues);
        await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopping", lastStage: "stopping", finishedAt: new Date(), stopReason: "replaced" } }).catch(() => undefined);
        await remoteDockerStop(transport, incumbent.containerName);
        await remoteDockerRemove(transport, incumbent.containerName);
        await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopped", lastStage: "stopping", stopReason: "replaced" } }).catch(() => undefined);
        await stageLog(incumbent.id, "stop", `Remote container ${incumbent.containerName} released host port ${hostPort} for a replacement deployment.`, secretValues);
      }
      // Whatever still holds the port is not ours and must never be stopped.
      const owner = await remotePortOwner(transport, hostPort);
      if (owner) throw new RemoteDeploymentError("remote_port_in_use", `Host port ${hostPort} on ${server.name} is held by container ${owner}, which Developer OS does not own.`, 409);
    },

    transferImage,

    start: async (request: StartRequest) => {
      const path = remoteEnvironmentFilePath(request.deploymentId);
      const name = containerName(request.projectSlug, request.environmentSlug, request.deploymentId);
      // The environment file carries every runtime variable, including the engine-controlled PORT, and
      // is the only place a secret value is ever written on the remote host.
      await remoteWriteEnvironmentFile(transport, path, renderEnvironmentFile({ PORT: String(request.containerPort), ...request.variables }));
      try {
        const containerId = await remoteDockerCreate(transport, remoteCreateCommand({ tag: request.tag, name, hostPort: request.hostPort, containerPort: request.containerPort, cpuLimit: request.cpuLimit, memoryLimit: request.memoryLimit, envFilePath: path }));
        await remoteDockerStart(transport, name);
        return { containerId, containerName: name };
      } finally {
        // Removed on both the success and the failure path, and always before anything runs or inspects
        // the container, so the secret's on-disk lifetime is a single container-create call.
        await remoteRemoveEnvironmentFile(transport, path);
      }
    },

    runRelease: async (name: string) => { await remoteDockerExecMigration(transport, name, (chunk) => { void stageLog(deploymentId, "release_command", chunk); }); },
    verifyHealth: (hostPort, healthPath, timeoutMs, retries): Promise<HealthCheckResult> => remoteHealthCheck(transport, hostPort, healthPath, retries, timeoutMs),
    captureDiagnostics: async (id, name: string) => {
      const diagnostics = await remoteContainerDiagnostics(transport, name);
      await stageLog(id, "runtime", `Container state: ${diagnostics.state}`);
      if (diagnostics.logs) await stageLog(id, "runtime", `Container logs (tail):\n${diagnostics.logs}`);
    },
    stopContainer: async (_containerId, name: string) => { await remoteDockerStop(transport, name); await remoteDockerRemove(transport, name); },
    restartContainer: async (_containerId, name: string) => { await remoteDockerRestart(transport, name); },
    containerExists: async (_containerId, name: string) => existsByName(name),
    runtime: async (_containerId, name: string): Promise<ContainerRuntime | null> => remoteContainerRuntime(transport, name),
    verifyRollbackImage: async (tag) => remoteDockerImageExists(transport, tag),
    close: async () => { await transport.close(); },
  };
}
