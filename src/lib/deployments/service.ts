import { prisma } from "@/lib/db";
import { runGit } from "@/lib/git/runner.ts";
import { deploymentRepository } from "./config";
import { containerExists, imageArchitecture as readImageArchitecture, imageTag, localDaemonArchitecture, portAvailable, DeploymentDockerError } from "./docker";
import { architectureFailureReason, compareArchitectures, describeArchitecture } from "./architecture";
import { discoverDockerfile } from "./dockerfile";
import { withDeploymentLock } from "./lock";
import { DeploymentConflictError } from "./errors";
import { hasDeploymentInProgress } from "./state";
import { assertTransition, deploymentStatuses, type DeploymentStatus } from "./lifecycle";
import { assertOwnedContainerName, ownedContainerName } from "./operations";
import { redactSecrets } from "./runtime-env";
import { resolveRuntimeEnvironment } from "./runtime-store";
import { deploymentStages, stageStream, StagedFailure, type Stage } from "./stages";
import { resolveDeploymentOps, buildImage, verifyOwnedContainer, type DeploymentOps, type StageLogger } from "./target-runtime";
import { reconcileForDeployment } from "@/lib/exposure/service";
import { RemoteDeploymentError } from "./remote/server";

export { deploymentStages, StagedFailure };
export type { Stage } from "./stages";

const maxLogBytes = Number(process.env.DEPLOYMENT_MAX_LOG_BYTES || 256 * 1024);
async function log(deploymentId: string, stream: string, message: string, secretValues: readonly string[] = []) { const bounded = redactSecrets(message, secretValues).slice(0, 2000); if (!deploymentId) return; await prisma.deploymentLog.create({ data: { deploymentId, stream, message: bounded } }).catch(() => undefined); const logs = await prisma.deploymentLog.findMany({ where: { deploymentId }, orderBy: { timestamp: "desc" }, select: { id: true, message: true } }).catch(() => []); let total = logs.reduce((sum, item) => sum + item.message.length, 0); for (const item of logs.slice(1000)) { await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } if (total > maxLogBytes) { for (const item of logs.reverse()) { if (total <= maxLogBytes) break; await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } } }
async function repositoryState(project: { localRepositoryPath: string | null }) { const { repositoryRoot } = await deploymentRepository(project.localRepositoryPath); const dockerfile = await discoverDockerfile(repositoryRoot); const status = await runGit(["status", "--porcelain"], repositoryRoot); if (status.stdout.trim()) throw new DeploymentDockerError("dirty_repository", "Deployment requires a clean Git working tree.", 409); const commitSha = (await runGit(["rev-parse", "HEAD"], repositoryRoot)).stdout.trim(); const branch = (await runGit(["branch", "--show-current"], repositoryRoot)).stdout.trim() || null; return { repositoryRoot, dockerfile, commitSha, branch }; }

// All status writes go through the lifecycle graph so impossible transitions are rejected server-side.
async function setStatus(id: string, from: string, to: DeploymentStatus, data: Record<string, unknown> = {}) { assertTransition(from, to); return prisma.deployment.update({ where: { id }, data: { ...data, status: to, lastStage: to } }); }

const withOps = async <T,>(deployment: DeploymentRecord, body: (ops: DeploymentOps, stageLog: StageLogger) => Promise<T>) => {
  const stageLog: StageLogger = async (deploymentId, stage, message, secretValues) => { await log(deploymentId, stageStream[stage], message, secretValues); };
  const ops = await resolveDeploymentOps(deployment, stageLog);
  // The SSH session is opened once per operation and always closed, including on failure.
  try { return await body(ops, stageLog); } finally { await ops.close(); }
};

const deploymentInclude = { project: { select: { id: true, name: true, slug: true, localRepositoryPath: true, userId: true } }, environment: { select: { id: true, name: true, slug: true, type: true, hostPort: true, containerPort: true, healthPath: true, healthTimeoutMs: true, healthRetries: true, cpuLimit: true, memoryLimit: true, runMigrations: true, target: true, serverId: true } } } as const;
type DeploymentRecord = { id: string; projectId: string; environmentId: string; target: string; serverId: string | null; imageTag: string; containerId: string | null; containerName: string | null; status: string; lastStage: string | null; project: { slug: string; userId: string; localRepositoryPath: string | null }; environment: { slug: string; hostPort: number; containerPort: number; healthPath: string; healthTimeoutMs: number; healthRetries: number; cpuLimit: string; memoryLimit: string; runMigrations: boolean; serverId: string | null } };

const findDeployment = (id: string) => prisma.deployment.findUnique({ where: { id }, include: deploymentInclude }) as Promise<DeploymentRecord | null>;

const loadDeploymentRecord = async (id: string) => { const record = await findDeployment(id); if (!record) throw new Error("Deployment not found."); return record; };

// Written once when the release stage finishes, and read back before the stage runs. This is what makes
// "migrate exactly once per deployment" a durable property rather than a best-effort one.
const releaseCompletedMarker = "Database migrations completed.";
async function releaseStageCompleted(deploymentId: string) {
  const existing = await prisma.deploymentLog.findFirst({ where: { deploymentId, stream: "release", message: releaseCompletedMarker }, select: { id: true } }).catch(() => null);
  return Boolean(existing);
}

export async function createDeployment(projectId: string, environmentId: string) {
  const environment = await prisma.deploymentEnvironment.findFirst({ where: { id: environmentId, projectId }, include: { project: true } });
  if (!environment) throw new Error("Environment not found.");
  return withDeploymentLock(projectId, environmentId, async () => {
    const active = await prisma.deployment.findFirst({ where: { environmentId, status: { in: ["pending", "building", "starting"] } } });
    if (active && hasDeploymentInProgress([active.status])) throw new DeploymentConflictError();
    const state = await repositoryState(environment.project);
    // The target and its server are copied from the environment onto the deployment, so a deployment
    // record always states where it runs and cannot be pointed elsewhere later.
    const deployment = await prisma.deployment.create({ data: { projectId, environmentId, commitSha: state.commitSha, branch: state.branch, dockerfile: state.dockerfile.name, imageTag: "pending", status: "pending", target: environment.target, serverId: environment.serverId } });
    const tag = imageTag(environment.project.slug, deployment.id);
    return prisma.deployment.update({ where: { id: deployment.id }, data: { imageTag: tag, remoteImageTag: environment.target === "remote" ? tag : null } });
  });
}

export async function deployDeployment(deploymentId: string) {
  const initial = await findDeployment(deploymentId);
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const current = await findDeployment(deploymentId);
    if (!current) throw new Error("Deployment not found.");
    if (!["pending", "failed", "stopped"].includes(current.status)) throw new DeploymentConflictError("This deployment is already active or has completed.");
    const active = await prisma.deployment.findFirst({ where: { environmentId: current.environmentId, id: { not: current.id }, status: { in: ["pending", "building", "starting"] } } });
    if (active) throw new DeploymentConflictError();
    const runtime = await resolveRuntimeEnvironment(current.environmentId);
    const secrets = runtime.secretValues;
    return withOps(current, async (ops, stageLog) => {
      let newContainer = "";
      let newName = "";
      let stage: Stage = "validation";
      try {
        // Target validation happens inside withOps, so a remote deployment proves the server is owned,
        // online, trusted, reachable, and Docker-capable before anything is built.
        if (ops.target === "remote") await stageLog(current.id, "validation", `Target: remote via ${ops.serverName}. Verifying server ownership, host key, Docker, and connection.`, secrets);
        const state = await repositoryState(current.project);
        await setStatus(current.id, current.status, "building", { commitSha: state.commitSha, branch: state.branch, dockerfile: state.dockerfile.name, startedAt: new Date(), errorMessage: null, stopReason: null });
        await stageLog(current.id, "validation", `Build started for ${state.commitSha.slice(0, 12)}.`, secrets);
        await stageLog(current.id, "validation", `Dockerfile: ${state.dockerfile.name}`, secrets);
        await stageLog(current.id, "validation", `Runtime variables configured: ${Object.keys(runtime.variables).sort().join(", ") || "none"} (values are never logged).`, secrets);
        if (runtime.unreadable.length) throw new StagedFailure("validation", `Stored secrets could not be decrypted: ${runtime.unreadable.join(", ")}.`, "runtime_secret_unreadable");

        stage = "build";
        const buildOutput = await buildImage(state.repositoryRoot, state.dockerfile.path, current.imageTag, (chunk) => { void stageLog(current.id, "build", chunk, secrets); });
        if (buildOutput) await stageLog(current.id, "build", "Docker image build completed.", secrets);

        // Architecture is checked after the build, because only a built image has an architecture, and
        // before the transfer, because transferring an image the target cannot execute wastes minutes and
        // leaves a daemon full of images that will never run. Cross-architecture emulation is not used:
        // this build host has no binfmt handlers registered, so a mismatch is a hard stop with
        // instructions rather than a silent attempt.
        stage = "architecture";
        const imageArchitecture = await readImageArchitecture(current.imageTag);
        // A remote target's architecture comes from the server record and may legitimately be unknown, for
        // instance when the server has never been probed. That null must survive to the comparison: falling
        // back to the local host's architecture here would substitute this machine's CPU for the target's
        // and quietly approve a deployment that cannot run.
        const targetArchitecture = ops.targetArchitecture ?? (ops.target === "local" ? await localDaemonArchitecture() : null);
        const architecture = compareArchitectures(imageArchitecture, targetArchitecture);
        await stageLog(current.id, "architecture", `Architecture preflight: ${describeArchitecture(imageArchitecture, targetArchitecture)}.`, secrets);
        if (!architecture.compatible) {
          throw new StagedFailure(
            "architecture",
            architectureFailureReason(architecture, imageArchitecture, targetArchitecture, ops.target === "remote" ? ops.serverName : null),
            architecture.reason === "server_unknown" ? "server_architecture_unknown" : "architecture_mismatch",
          );
        }

        // Transfer is a no-op for a local target; a remote target streams the image over pinned SSH.
        if (ops.target === "remote") {
          stage = "transfer";
          await prisma.deployment.update({ where: { id: current.id }, data: { transferStartedAt: new Date() } }).catch(() => undefined);
          await ops.transferImage(current.imageTag, secrets);
          stage = "remote_image";
          await stageLog(current.id, "remote_image", `Image ${current.imageTag} loaded on ${ops.serverName}.`, secrets);
        }

        stage = "port";
        await ops.releaseHostPort({ environmentId: current.environmentId, excludeDeploymentId: current.id, hostPort: current.environment.hostPort }, secrets);
        // A local deployment keeps the original local check; a remote one already verified the port
        // against the remote host inside releaseHostPort, where the Docker state is authoritative.
        if (ops.target === "local" && !await portAvailable(current.environment.hostPort)) throw new StagedFailure("port", `Host port ${current.environment.hostPort} is already in use by a process Developer OS does not own.`, "port_in_use");

        stage = "container_startup";
        await setStatus(current.id, "building", "starting");
        const started = await ops.start({ projectSlug: current.project.slug, environmentSlug: current.environment.slug, deploymentId: current.id, tag: current.imageTag, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, variables: runtime.variables });
        newContainer = started.containerId;
        newName = started.containerName;
        await prisma.deployment.update({ where: { id: current.id }, data: { containerId: newContainer, containerName: newName } });
        await stageLog(current.id, "container_startup", `${ops.target === "remote" ? "Remote" : ""} container ${newName} started.`.replace(/^Remote/, "Remote"), secrets);

        // The release stage runs at most once per deployment record. Completion is read back from the persisted
        // log rather than from `lastStage`, because `lastStage` tracks the lifecycle status and is
        // overwritten by every status write, so it cannot express "the release stage already ran".
        // A retried deployment therefore cannot run migrations a second time.
        if (current.environment.runMigrations && !(await releaseStageCompleted(current.id))) {
          stage = "release_command";
          await stageLog(current.id, "release_command", "Running database migrations.", secrets);
          await ops.runRelease(newName);
          await stageLog(current.id, "release_command", releaseCompletedMarker, secrets);
        }

        stage = "health_check";
        const health = await ops.verifyHealth(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries);
        if (!health.healthy) {
          await stageLog(current.id, "health_check", `Health check URL: ${health.url}`, secrets);
          await stageLog(current.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, secrets);
          if (health.bodyExcerpt) await stageLog(current.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, secrets);
          throw new StagedFailure("health_check", health.message, "health_check_failed");
        }
        await stageLog(current.id, "health_check", health.message, secrets);
        await setStatus(current.id, "starting", "running", { healthStatus: "healthy", finishedAt: new Date() });
        // This deployment now serves the environment's port, so any hostname routed there resolves to it.
        await reconcileForDeployment(current.id);
        return prisma.deployment.findUnique({ where: { id: current.id } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Deployment failed.";
        if (newContainer) await ops.captureDiagnostics(current.id, newName || newContainer);
        const failedStage = error instanceof StagedFailure ? error.stage : error instanceof RemoteDeploymentError ? "transfer" : stage;
        await stageLog(current.id, failedStage, `[${failedStage}] ${message}`, secrets);
        await prisma.deployment.update({ where: { id: current.id }, data: { status: "failed", lastStage: failedStage, healthStatus: "unhealthy", errorMessage: `[${failedStage}] ${message}`, finishedAt: new Date() } });
        if (newContainer) await ops.stopContainer(newContainer, newName).catch(() => undefined);
        throw error;
      }
    });
  });
}

export async function stopDeployment(deploymentId: string, reason = "operator_requested") {
  const initial = await findDeployment(deploymentId);
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const deployment = await findDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found.");
    const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
    const secrets = runtime.secretValues;
    if (!deployment.containerId) throw new DeploymentDockerError("no_owned_container", "This deployment has no container to stop.", 409);
    const name = assertOwnedContainerName(deployment);
    return withOps(deployment, async (ops, stageLog) => {
      if (!(await ops.containerExists(deployment.containerId as string, name))) {
        // Stopping must be idempotent. A redeploy or a rollback already stopped and removed this
        // container and set the record to a terminal status, so there is nothing left to stop and
        // reporting a conflict would make teardown and retry fail on a state that is already correct.
        // The recorded container id is cleared so the record stops claiming one.
        //
        // These are the terminal DeploymentStatus values, none of which has a container that should
        // still be running. A record that claims a container which vanished while it was live is a
        // different situation: that is drift worth reporting rather than absorbing.
        // Every DeploymentStatus that has no container that should still be running. Derived from the canonical
        // list rather than retyped, so adding a status in lifecycle.ts cannot silently leave it out.
        const terminal = deploymentStatuses.filter((status) => !["pending", "building", "starting", "running", "unhealthy", "stopping"].includes(status));
        if (terminal.includes(deployment.status as DeploymentStatus)) {
          await stageLog(deployment.id, "stop", `Container ${name} is already gone; nothing to stop.`, secrets);
          return prisma.deployment.update({ where: { id: deployment.id }, data: { containerId: null, lastStage: "stop" } });
        }
        throw new DeploymentDockerError("container_not_found", `Owned container ${name} no longer exists.`, 409);
      }
      const wasRunning = ["running", "unhealthy", "starting"].includes(deployment.status);
      if (wasRunning) {
        await setStatus(deployment.id, deployment.status, "stopping", { stopReason: reason });
        await stageLog(deployment.id, "stop", `Stopping owned container ${name}.`, secrets);
        await ops.captureDiagnostics(deployment.id, name);
      } else {
        await stageLog(deployment.id, "stop", `Stop requested while deployment is ${deployment.status}.`, secrets);
      }
      await ops.stopContainer(deployment.containerId as string, name);
      await stageLog(deployment.id, "stop", `Container ${name} stopped and removed. Logs and metadata are preserved.`, secrets);
      const stopped = await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "stopped", lastStage: "stop", healthStatus: "stopped", finishedAt: new Date(), stopReason: reason } });
      // Nothing serves this deployment any more, so any hostname routed to it has to be withdrawn.
      await reconcileForDeployment(deployment.id);
      return stopped;
    });
  });
}

export async function restartDeployment(deploymentId: string) {
  const initial = await findDeployment(deploymentId);
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const deployment = await findDeployment(deploymentId);
    if (!deployment) throw new Error("Deployment not found.");
    const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
    const secrets = runtime.secretValues;
    if (!deployment.containerId) throw new DeploymentDockerError("no_owned_container", "This deployment has no container to restart.", 409);
    const name = assertOwnedContainerName(deployment);
    return withOps(deployment, async (ops, stageLog) => {
      if (!(await ops.containerExists(deployment.containerId as string, name))) throw new DeploymentDockerError("container_not_found", `Owned container ${name} no longer exists.`, 409);
      try {
        await stageLog(deployment.id, "restart", `Restarting owned container ${name}.`, secrets);
        await ops.restartContainer(deployment.containerId as string, name);
        await stageLog(deployment.id, "restart", `Container ${name} restarted.`, secrets);
        const health = await ops.verifyHealth(deployment.environment.hostPort, deployment.environment.healthPath, deployment.environment.healthTimeoutMs, deployment.environment.healthRetries);
        if (!health.healthy) {
          await stageLog(deployment.id, "health_check", `Health check URL: ${health.url}`, secrets);
          await stageLog(deployment.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, secrets);
          if (health.bodyExcerpt) await stageLog(deployment.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, secrets);
          await ops.captureDiagnostics(deployment.id, name);
          await stageLog(deployment.id, "restart", `[health_check] Restarted container is not healthy: ${health.message}`, secrets);
          const unhealthy = await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "unhealthy", lastStage: "health_check", healthStatus: "unhealthy", errorMessage: `[health_check] ${health.message}`, restartedAt: new Date() } });
          await reconcileForDeployment(deployment.id);
          return unhealthy;
        }
        await stageLog(deployment.id, "health_check", health.message, secrets);
        await stageLog(deployment.id, "restart", `Restart completed and health check passed.`, secrets);
        const restarted = await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "running", lastStage: "restart", healthStatus: "healthy", errorMessage: null, restartedAt: new Date() } });
        await reconcileForDeployment(deployment.id);
        return restarted;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Restart failed.";
        await ops.captureDiagnostics(deployment.id, name);
        await stageLog(deployment.id, "restart", `[restart] ${message}`, secrets);
        await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "unhealthy", lastStage: "restart", healthStatus: "unhealthy", errorMessage: `[restart] ${message}`, restartedAt: new Date() } });
        throw error;
      }
    });
  });
}

export async function redeployDeployment(deploymentId: string) {
  const source = await findDeployment(deploymentId);
  if (!source) throw new Error("Deployment not found.");
  const active = await prisma.deployment.findFirst({ where: { environmentId: source.environmentId, status: { in: ["pending", "building", "starting"] } } });
  if (active) throw new DeploymentConflictError();
  // A new record is created against the same environment, so the same server and configuration apply.
  // The source deployment is never mutated.
  const created = await createDeployment(source.projectId, source.environmentId) as { id: string; target: string; serverId: string | null } | null;
  const runtime = await resolveRuntimeEnvironment(source.environmentId);
  if (!created?.id) throw new DeploymentDockerError("redeploy_failed", "Redeploy could not create a deployment record.", 409);
  const stageLog: StageLogger = async (deploymentId, stage, message, secretValues) => { await log(deploymentId, stageStream[stage], message, secretValues); };
  await stageLog(created.id, "validation", `Redeploy of ${source.id} using the current environment configuration${created.target === "remote" ? " on the same remote server" : ""}.`, runtime.secretValues);
  await stageLog(created.id, "validation", `Runtime variables configured: ${Object.keys(runtime.variables).sort().join(", ") || "none"} (values are never logged).`, runtime.secretValues);
  return created;
}

export async function rollbackCandidates(deploymentId: string) {
  const current = await findDeployment(deploymentId);
  if (!current) throw new Error("Deployment not found.");
  const candidates = await prisma.deployment.findMany({ where: { environmentId: current.environmentId, id: { not: current.id }, status: { in: ["running", "stopped", "rolled_back"] }, imageTag: { not: "pending" } }, orderBy: { createdAt: "desc" }, take: 20 });
  return withOps(current, async (ops) => {
    const eligible = [];
    for (const candidate of candidates) {
      // The image must still exist on the target this deployment will roll back onto, and the candidate
      // must belong to the same server.
      if (candidate.serverId !== current.serverId) continue;
      if (!(await ops.verifyRollbackImage(candidate.imageTag))) continue;
      eligible.push({ id: candidate.id, commitSha: candidate.commitSha, branch: candidate.branch, imageTag: candidate.imageTag, dockerfile: candidate.dockerfile, healthStatus: candidate.healthStatus, status: candidate.status, createdAt: candidate.createdAt, finishedAt: candidate.finishedAt });
    }
    return eligible;
  });
}

// Rollback deploys the exact known-good image of the selected deployment. It never rebuilds from current
// source and never transfers a different image.
export async function rollbackDeployment(deploymentId: string, targetDeploymentId?: string) {
  const current = await findDeployment(deploymentId);
  if (!current) throw new Error("Deployment not found.");
  const targetId = targetDeploymentId ?? (await rollbackCandidates(deploymentId))[0]?.id;
  if (!targetId) throw new DeploymentDockerError("rollback_unavailable", "No previous successful deployment image is available for rollback.", 409);
  const target = await prisma.deployment.findFirst({ where: { id: targetId, environmentId: current.environmentId } });
  if (!target) throw new DeploymentDockerError("rollback_unavailable", "Selected rollback deployment does not belong to this environment.", 409);
  // A rollback may only reuse an image that is present on the same target host.
  if (target.serverId !== current.serverId) throw new DeploymentDockerError("remote_rollback_image_missing", "The selected rollback deployment targeted a different server.", 409);
  // Rollback creates its own deployment record; the known-good deployment is never mutated.
  const created = await prisma.deployment.create({ data: { projectId: current.projectId, environmentId: current.environmentId, commitSha: target.commitSha, branch: target.branch, dockerfile: target.dockerfile, imageTag: target.imageTag, rollbackOfId: current.id, rolledBackFromId: current.id, status: "pending", target: current.target as "local" | "remote", serverId: current.serverId, remoteImageTag: current.target === "remote" ? target.imageTag : null } });
  const rollback = await loadDeploymentRecord(created.id);
  return withDeploymentLock(current.projectId, current.environmentId, async () => {
    const runtime = await resolveRuntimeEnvironment(current.environmentId);
    const secrets = runtime.secretValues;
    return withOps(rollback, async (ops, stageLog) => {
      let container = "";
      let name = "";
      try {
        if (!(await ops.verifyRollbackImage(target.imageTag))) throw new DeploymentDockerError("remote_rollback_image_missing", "The known-good image is no longer available on the target server.", 409);
        await setStatus(rollback.id, "pending", "starting");
        await stageLog(rollback.id, "rollback", `Rolling back to known-good deployment ${target.id}.`, secrets);
        await stageLog(rollback.id, "rollback", `Image: ${target.imageTag} (commit ${target.commitSha.slice(0, 12)}). No rebuild from current source.`, secrets);
        await ops.releaseHostPort({ environmentId: current.environmentId, excludeDeploymentId: rollback.id, hostPort: current.environment.hostPort }, secrets);
        if (ops.target === "local" && !await portAvailable(current.environment.hostPort)) throw new DeploymentDockerError("port_in_use", "Host port is already in use by a process Developer OS does not own.", 409);
        const started = await ops.start({ projectSlug: current.project.slug, environmentSlug: current.environment.slug, deploymentId: rollback.id, tag: target.imageTag, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, variables: runtime.variables });
        container = started.containerId;
        name = started.containerName;
        await prisma.deployment.update({ where: { id: rollback.id }, data: { containerId: container, containerName: name } });
        await stageLog(rollback.id, "container_startup", `Container ${name} started from the known-good image.`, secrets);
        if (current.environment.runMigrations) await ops.runRelease(name);
        const health = await ops.verifyHealth(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries);
        if (!health.healthy) {
          await stageLog(rollback.id, "health_check", `Health check URL: ${health.url}`, secrets);
          await stageLog(rollback.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, secrets);
          if (health.bodyExcerpt) await stageLog(rollback.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, secrets);
          throw new DeploymentDockerError("health_failed", health.message, 409);
        }
        await stageLog(rollback.id, "health_check", health.message, secrets);
        await setStatus(rollback.id, "starting", "running", { healthStatus: "healthy", finishedAt: new Date() });
        await prisma.deployment.update({ where: { id: current.id }, data: { status: "rolled_back", lastStage: "rollback", healthStatus: "rolled_back", finishedAt: new Date(), stopReason: "rolled_back" } });
        await reconcileForDeployment(rollback.id);
        return prisma.deployment.findUnique({ where: { id: rollback.id } });
      } catch (error) {
        if (container) await ops.captureDiagnostics(rollback.id, name || container);
        const message = error instanceof Error ? error.message : "Rollback failed.";
        await stageLog(rollback.id, "rollback", `[rollback] ${message}`, secrets);
        await prisma.deployment.update({ where: { id: rollback.id }, data: { status: "failed", lastStage: "rollback", errorMessage: `[rollback] ${message}`, finishedAt: new Date() } });
        if (container) await ops.stopContainer(container, name).catch(() => undefined);
        throw error;
      }
    });
  });
}

export async function deploymentRuntime(deploymentId: string) {
  const deployment = await findDeployment(deploymentId);
  if (!deployment) throw new Error("Deployment not found.");
  const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
  const names = Object.keys(runtime.variables).sort();
  const secretNames = names.filter((variableName) => ["APP_KEY", "DB_PASSWORD"].includes(variableName));
  if (!deployment.containerId) return { owned: true, container: null, runtimeVariableNames: names, target: deployment.target, serverId: deployment.serverId };
  const name = assertOwnedContainerName(deployment);
  return withOps(deployment, async (ops) => {
    const owned = await ops.containerExists(deployment.containerId as string, name);
    if (!owned) return { owned: false, container: null, runtimeVariableNames: names, target: deployment.target, serverId: deployment.serverId };
    const container = await ops.runtime(deployment.containerId as string, name);
    // Only safe, allowlisted runtime fields are returned: no environment, command line, mounts, or labels.
    return { owned: true, container, runtimeVariableNames: names, secretNames, target: deployment.target, serverId: deployment.serverId };
  });
}

export async function deploymentOwnedContainerName(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: { select: { slug: true } }, environment: { select: { slug: true } } } });
  if (!deployment) throw new Error("Deployment not found.");
  return ownedContainerName(deployment);
}

export { containerExists, verifyOwnedContainer };
