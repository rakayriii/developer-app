import { prisma } from "@/lib/db";
import { runGit } from "@/lib/git/runner.ts";
import { deploymentRepository } from "./config";
import { buildImage, containerDiagnostics, containerName, containerExists, containerRuntime, execReleaseCommand, healthCheck, imageExists, imageTag, portAvailable, restartOwnedContainer, startContainer, stopOwnedContainer, verifyOwnedContainer, DeploymentDockerError } from "./docker";
import { discoverDockerfile } from "./dockerfile";
import { withDeploymentLock } from "./lock";
import { DeploymentConflictError } from "./errors";
import { hasDeploymentInProgress } from "./state";
import { assertTransition, type DeploymentStatus } from "./lifecycle";
import { assertOwnedContainerName, ownedContainerName } from "./operations";
import { redactSecrets } from "./runtime-env";
import { resolveRuntimeEnvironment } from "./runtime-store";

const maxLogBytes = Number(process.env.DEPLOYMENT_MAX_LOG_BYTES || 256 * 1024);
async function log(deploymentId: string, stream: string, message: string, secretValues: readonly string[] = []) { const bounded = redactSecrets(message, secretValues).slice(0, 2000); await prisma.deploymentLog.create({ data: { deploymentId, stream, message: bounded } }).catch(() => undefined); const logs = await prisma.deploymentLog.findMany({ where: { deploymentId }, orderBy: { timestamp: "desc" }, select: { id: true, message: true } }).catch(() => []); let total = logs.reduce((sum, item) => sum + item.message.length, 0); for (const item of logs.slice(1000)) { await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } if (total > maxLogBytes) { for (const item of logs.reverse()) { if (total <= maxLogBytes) break; await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } } }
async function repositoryState(project: { localRepositoryPath: string | null }) { const { repositoryRoot } = await deploymentRepository(project.localRepositoryPath); const dockerfile = await discoverDockerfile(repositoryRoot); const status = await runGit(["status", "--porcelain"], repositoryRoot); if (status.stdout.trim()) throw new DeploymentDockerError("dirty_repository", "Deployment requires a clean Git working tree.", 409); const commitSha = (await runGit(["rev-parse", "HEAD"], repositoryRoot)).stdout.trim(); const branch = (await runGit(["branch", "--show-current"], repositoryRoot)).stdout.trim() || null; return { repositoryRoot, dockerfile, commitSha, branch }; }

export type Stage = "validation" | "build" | "container_startup" | "port" | "release_command" | "health_check" | "runtime" | "stop" | "restart" | "rollback";
export const deploymentStages: readonly Stage[] = ["validation", "build", "container_startup", "port", "release_command", "health_check", "runtime", "stop", "restart", "rollback"];
const stageStream: Record<Stage, string> = { validation: "validation", build: "build", container_startup: "container", port: "system", release_command: "release", health_check: "health", runtime: "runtime", stop: "stop", restart: "restart", rollback: "rollback" };
class StagedFailure extends Error { stage: Stage; code: string; status = 409; constructor(stage: Stage, message: string, code = "health_check_failed") { super(message); this.stage = stage; this.code = code; } }

async function stageLog(deploymentId: string, stage: Stage, message: string, secretValues: readonly string[] = []) { await log(deploymentId, stageStream[stage], message, secretValues); }

// All status writes go through the lifecycle graph so impossible transitions are rejected server-side.
async function setStatus(id: string, from: string, to: DeploymentStatus, data: Record<string, unknown> = {}) {
  assertTransition(from, to);
  return prisma.deployment.update({ where: { id }, data: { ...data, status: to, lastStage: to } });
}

async function captureDiagnostics(deploymentId: string, containerId: string, secretValues: readonly string[]) {
  const diagnostics = await containerDiagnostics(containerId).catch(() => ({ state: "unknown", logs: "" }));
  await stageLog(deploymentId, "runtime", `Container state: ${diagnostics.state}`, secretValues);
  if (diagnostics.logs) await stageLog(deploymentId, "runtime", `Container logs (tail):\n${diagnostics.logs}`, secretValues);
}

// A host port can only be bound once, so an incumbent owned container must be released before a
// replacement can start. Only containers owned by Developer OS are ever touched, and the incumbent's
// logs are captured first so the evidence survives.
async function releaseHostPort(environmentId: string, excludeDeploymentId: string, secretValues: readonly string[]) {
  const incumbents = await prisma.deployment.findMany({ where: { environmentId, id: { not: excludeDeploymentId }, status: { in: ["running", "unhealthy", "starting"] }, containerId: { not: null } }, orderBy: { createdAt: "desc" } });
  const released: { id: string; containerName: string | null }[] = [];
  for (const incumbent of incumbents) {
    if (!incumbent.containerId || !incumbent.containerName) continue;
    if (!incumbent.containerName.startsWith("developer-os-")) continue;
    if (!(await verifyOwnedContainer(incumbent.containerName))) continue;
    await captureDiagnostics(incumbent.id, incumbent.containerId, secretValues);
    await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopping", lastStage: "stopping", finishedAt: new Date(), stopReason: "replaced" } }).catch(() => undefined);
    await stopOwnedContainer(incumbent.containerId);
    await prisma.deployment.update({ where: { id: incumbent.id }, data: { status: "stopped", lastStage: "stopping", stopReason: "replaced" } }).catch(() => undefined);
    await stageLog(incumbent.id, "stop", `Container ${incumbent.containerName} released the host port for a replacement deployment.`, secretValues);
    released.push({ id: incumbent.id, containerName: incumbent.containerName });
  }
  return released;
}

export async function createDeployment(projectId: string, environmentId: string) { const environment = await prisma.deploymentEnvironment.findFirst({ where: { id: environmentId, projectId }, include: { project: true } }); if (!environment) throw new Error("Environment not found."); return withDeploymentLock(projectId, environmentId, async () => { const active = await prisma.deployment.findFirst({ where: { environmentId, status: { in: ["pending", "building", "starting"] } } }); if (active && hasDeploymentInProgress([active.status])) throw new DeploymentConflictError(); const state = await repositoryState(environment.project); const deployment = await prisma.deployment.create({ data: { projectId, environmentId, commitSha: state.commitSha, branch: state.branch, dockerfile: state.dockerfile.name, imageTag: "pending", status: "pending" } }); const tag = imageTag(environment.project.slug, deployment.id); return prisma.deployment.update({ where: { id: deployment.id }, data: { imageTag: tag } }); }); }

export async function deployDeployment(deploymentId: string) {
  const initial = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const current = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
    if (!current) throw new Error("Deployment not found.");
    if (!["pending", "failed", "stopped"].includes(current.status)) throw new DeploymentConflictError("This deployment is already active or has completed.");
    const active = await prisma.deployment.findFirst({ where: { environmentId: current.environmentId, id: { not: current.id }, status: { in: ["pending", "building", "starting"] } } });
    if (active) throw new DeploymentConflictError();
    const runtime = await resolveRuntimeEnvironment(current.environmentId);
    let newContainer = "";
    let stage: Stage = "validation";
    try {
      const state = await repositoryState(current.project);
      await setStatus(current.id, current.status, "building", { commitSha: state.commitSha, branch: state.branch, dockerfile: state.dockerfile.name, startedAt: new Date(), errorMessage: null, stopReason: null });
      await stageLog(current.id, "validation", `Build started for ${state.commitSha.slice(0, 12)}.`, runtime.secretValues);
      await stageLog(current.id, "validation", `Dockerfile: ${state.dockerfile.name}`, runtime.secretValues);
      await stageLog(current.id, "validation", `Runtime variables configured: ${Object.keys(runtime.variables).sort().join(", ") || "none"} (values are never logged).`, runtime.secretValues);
      if (runtime.unreadable.length) throw new StagedFailure("validation", `Stored secrets could not be decrypted: ${runtime.unreadable.join(", ")}.`, "runtime_secret_unreadable");
      stage = "build";
      const buildOutput = await buildImage(state.repositoryRoot, state.dockerfile.path, current.imageTag, (chunk) => { void stageLog(current.id, "build", chunk, runtime.secretValues); });
      if (buildOutput) await stageLog(current.id, "build", "Docker image build completed.", runtime.secretValues);
      stage = "port";
      // Release any incumbent owned container first; the host port cannot be bound twice.
      await releaseHostPort(current.environmentId, current.id, runtime.secretValues);
      if (!await portAvailable(current.environment.hostPort)) throw new StagedFailure("port", `Host port ${current.environment.hostPort} is already in use by a process Developer OS does not own.`, "port_in_use");
      stage = "container_startup";
      await setStatus(current.id, "building", "starting");
      const name = containerName(current.project.slug, current.environment.slug, current.id);
      newContainer = await startContainer({ tag: current.imageTag, name, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, environment: runtime.variables });
      await prisma.deployment.update({ where: { id: current.id }, data: { containerId: newContainer, containerName: name } });
      await stageLog(current.id, "container_startup", `Container ${name} started.`, runtime.secretValues);
      if (current.environment.runMigrations) {
        stage = "release_command";
        await stageLog(current.id, "release_command", "Running database migrations.", runtime.secretValues);
        await execReleaseCommand(newContainer, "migrate", (chunk) => { void stageLog(current.id, "release_command", chunk, runtime.secretValues); });
        await stageLog(current.id, "release_command", "Database migrations completed.", runtime.secretValues);
      }
      stage = "health_check";
      const health = await healthCheck(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries);
      if (!health.healthy) {
        await stageLog(current.id, "health_check", `Health check URL: ${health.url}`, runtime.secretValues);
        await stageLog(current.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, runtime.secretValues);
        if (health.bodyExcerpt) await stageLog(current.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, runtime.secretValues);
        throw new StagedFailure("health_check", health.message, "health_check_failed");
      }
      await stageLog(current.id, "health_check", health.message, runtime.secretValues);
      await setStatus(current.id, "starting", "running", { healthStatus: "healthy", finishedAt: new Date() });
      return prisma.deployment.findUnique({ where: { id: current.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Deployment failed.";
      if (newContainer) await captureDiagnostics(current.id, newContainer, runtime.secretValues);
      const failedStage = error instanceof StagedFailure ? error.stage : stage;
      await stageLog(current.id, failedStage, `[${failedStage}] ${message}`, runtime.secretValues);
      await prisma.deployment.update({ where: { id: current.id }, data: { status: "failed", lastStage: failedStage, healthStatus: "unhealthy", errorMessage: `[${failedStage}] ${message}`, finishedAt: new Date() } });
      if (newContainer) await stopOwnedContainer(newContainer);
      throw error;
    }
  });
}

export async function stopDeployment(deploymentId: string, reason = "operator_requested") {
  const initial = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
    if (!deployment) throw new Error("Deployment not found.");
    const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
    if (!deployment.containerId) throw new DeploymentDockerError("no_owned_container", "This deployment has no container to stop.", 409);
    const name = assertOwnedContainerName(deployment);
    if (!(await verifyOwnedContainer(name))) throw new DeploymentDockerError("container_not_found", `Owned container ${name} no longer exists.`, 409);
    const wasRunning = ["running", "unhealthy", "starting"].includes(deployment.status);
    if (wasRunning) {
      await setStatus(deployment.id, deployment.status, "stopping", { stopReason: reason });
      await stageLog(deployment.id, "stop", `Stopping owned container ${name}.`, runtime.secretValues);
      await captureDiagnostics(deployment.id, deployment.containerId, runtime.secretValues);
    } else {
      await stageLog(deployment.id, "stop", `Stop requested while deployment is ${deployment.status}.`, runtime.secretValues);
    }
    await stopOwnedContainer(deployment.containerId);
    await stageLog(deployment.id, "stop", `Container ${name} stopped and removed. Logs and metadata are preserved.`, runtime.secretValues);
    return prisma.deployment.update({ where: { id: deployment.id }, data: { status: "stopped", lastStage: "stop", healthStatus: "stopped", finishedAt: new Date(), stopReason: reason } });
  });
}

export async function restartDeployment(deploymentId: string) {
  const initial = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!initial) throw new Error("Deployment not found.");
  return withDeploymentLock(initial.projectId, initial.environmentId, async () => {
    const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
    if (!deployment) throw new Error("Deployment not found.");
    const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
    if (!deployment.containerId) throw new DeploymentDockerError("no_owned_container", "This deployment has no container to restart.", 409);
    const name = assertOwnedContainerName(deployment);
    if (!(await verifyOwnedContainer(name))) throw new DeploymentDockerError("container_not_found", `Owned container ${name} no longer exists.`, 409);
    try {
      await stageLog(deployment.id, "restart", `Restarting owned container ${name}.`, runtime.secretValues);
      await restartOwnedContainer(deployment.containerId);
      await stageLog(deployment.id, "restart", `Container ${name} restarted.`, runtime.secretValues);
      const health = await healthCheck(deployment.environment.hostPort, deployment.environment.healthPath, deployment.environment.healthTimeoutMs, deployment.environment.healthRetries);
      if (!health.healthy) {
        await stageLog(deployment.id, "health_check", `Health check URL: ${health.url}`, runtime.secretValues);
        await stageLog(deployment.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, runtime.secretValues);
        if (health.bodyExcerpt) await stageLog(deployment.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, runtime.secretValues);
        await captureDiagnostics(deployment.id, deployment.containerId, runtime.secretValues);
        await stageLog(deployment.id, "restart", `[health_check] Restarted container is not healthy: ${health.message}`, runtime.secretValues);
        return prisma.deployment.update({ where: { id: deployment.id }, data: { status: "unhealthy", lastStage: "health_check", healthStatus: "unhealthy", errorMessage: `[health_check] ${health.message}`, restartedAt: new Date() } });
      }
      await stageLog(deployment.id, "health_check", health.message, runtime.secretValues);
      await stageLog(deployment.id, "restart", `Restart completed and health check passed.`, runtime.secretValues);
      return prisma.deployment.update({ where: { id: deployment.id }, data: { status: "running", lastStage: "restart", healthStatus: "healthy", errorMessage: null, restartedAt: new Date() } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Restart failed.";
      await captureDiagnostics(deployment.id, deployment.containerId, runtime.secretValues);
      await stageLog(deployment.id, "restart", `[restart] ${message}`, runtime.secretValues);
      await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "unhealthy", lastStage: "restart", healthStatus: "unhealthy", errorMessage: `[restart] ${message}`, restartedAt: new Date() } });
      throw error;
    }
  });
}

export async function redeployDeployment(deploymentId: string) {
  const source = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!source) throw new Error("Deployment not found.");
  const active = await prisma.deployment.findFirst({ where: { environmentId: source.environmentId, status: { in: ["pending", "building", "starting"] } } });
  if (active) throw new DeploymentConflictError();
  // A new record is created; the source deployment is never mutated.
  const created = await createDeployment(source.projectId, source.environmentId) as { id: string } | null;
  const runtime = await resolveRuntimeEnvironment(source.environmentId);
  if (!created?.id) throw new DeploymentDockerError("redeploy_failed", "Redeploy could not create a deployment record.", 409);
  await stageLog(created.id, "validation", `Redeploy of ${source.id} using the current environment configuration.`, runtime.secretValues);
  await stageLog(created.id, "validation", `Runtime variables configured: ${Object.keys(runtime.variables).sort().join(", ") || "none"} (values are never logged).`, runtime.secretValues);
  return created;
}

export async function rollbackCandidates(deploymentId: string) {
  const current = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!current) throw new Error("Deployment not found.");
  const candidates = await prisma.deployment.findMany({ where: { environmentId: current.environmentId, id: { not: current.id }, status: { in: ["running", "stopped", "rolled_back"] }, imageTag: { not: "pending" } }, orderBy: { createdAt: "desc" }, take: 20 });
  const eligible = [];
  for (const candidate of candidates) if (await imageExists(candidate.imageTag)) eligible.push({ id: candidate.id, commitSha: candidate.commitSha, branch: candidate.branch, imageTag: candidate.imageTag, dockerfile: candidate.dockerfile, healthStatus: candidate.healthStatus, status: candidate.status, createdAt: candidate.createdAt, finishedAt: candidate.finishedAt });
  return eligible;
}

// Rollback deploys the exact known-good image of the selected deployment. It never rebuilds from current source.
export async function rollbackDeployment(deploymentId: string, targetDeploymentId?: string) {
  const current = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!current) throw new Error("Deployment not found.");
  const targetId = targetDeploymentId ?? (await rollbackCandidates(deploymentId))[0]?.id;
  if (!targetId) throw new DeploymentDockerError("rollback_unavailable", "No previous successful deployment image is available for rollback.", 409);
  const target = await prisma.deployment.findFirst({ where: { id: targetId, environmentId: current.environmentId } });
  if (!target) throw new DeploymentDockerError("rollback_unavailable", "Selected rollback deployment does not belong to this environment.", 409);
  if (!(await imageExists(target.imageTag))) throw new DeploymentDockerError("rollback_unavailable", "The selected deployment image is no longer available locally.", 409);
  const rollback = await prisma.deployment.create({ data: { projectId: current.projectId, environmentId: current.environmentId, commitSha: target.commitSha, branch: target.branch, dockerfile: target.dockerfile, imageTag: target.imageTag, rollbackOfId: current.id, rolledBackFromId: current.id, status: "pending" } });
  return withDeploymentLock(current.projectId, current.environmentId, async () => {
    const runtime = await resolveRuntimeEnvironment(current.environmentId);
    let container = "";
    try {
      await setStatus(rollback.id, "pending", "starting");
      await stageLog(rollback.id, "rollback", `Rolling back to known-good deployment ${target.id}.`, runtime.secretValues);
      await stageLog(rollback.id, "rollback", `Image: ${target.imageTag} (commit ${target.commitSha.slice(0, 12)}). No rebuild from current source.`, runtime.secretValues);
      await releaseHostPort(current.environmentId, rollback.id, runtime.secretValues);
      if (!await portAvailable(current.environment.hostPort)) throw new DeploymentDockerError("port_in_use", "Host port is already in use by a process Developer OS does not own.", 409);
      const name = containerName(current.project.slug, current.environment.slug, rollback.id);
      container = await startContainer({ tag: target.imageTag, name, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, environment: runtime.variables });
      await prisma.deployment.update({ where: { id: rollback.id }, data: { containerId: container, containerName: name } });
      await stageLog(rollback.id, "container_startup", `Container ${name} started from the known-good image.`, runtime.secretValues);
      if (current.environment.runMigrations) await execReleaseCommand(container, "migrate", (chunk) => { void stageLog(rollback.id, "release_command", chunk, runtime.secretValues); });
      const health = await healthCheck(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries);
      if (!health.healthy) {
        await stageLog(rollback.id, "health_check", `Health check URL: ${health.url}`, runtime.secretValues);
        await stageLog(rollback.id, "health_check", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, runtime.secretValues);
        if (health.bodyExcerpt) await stageLog(rollback.id, "health_check", `Response excerpt: ${health.bodyExcerpt}`, runtime.secretValues);
        throw new DeploymentDockerError("health_failed", health.message, 409);
      }
      await stageLog(rollback.id, "health_check", health.message, runtime.secretValues);
      await setStatus(rollback.id, "starting", "running", { healthStatus: "healthy", finishedAt: new Date() });
      await prisma.deployment.update({ where: { id: current.id }, data: { status: "rolled_back", lastStage: "rollback", healthStatus: "rolled_back", finishedAt: new Date(), stopReason: "rolled_back" } });
      return prisma.deployment.findUnique({ where: { id: rollback.id } });
    } catch (error) {
      if (container) await captureDiagnostics(rollback.id, container, runtime.secretValues);
      const message = error instanceof Error ? error.message : "Rollback failed.";
      await stageLog(rollback.id, "rollback", `[rollback] ${message}`, runtime.secretValues);
      await prisma.deployment.update({ where: { id: rollback.id }, data: { status: "failed", lastStage: "rollback", errorMessage: `[rollback] ${message}`, finishedAt: new Date() } });
      if (container) await stopOwnedContainer(container);
      throw error;
    }
  });
}

export async function deploymentRuntime(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } });
  if (!deployment) throw new Error("Deployment not found.");
  const runtime = await resolveRuntimeEnvironment(deployment.environmentId);
  if (!deployment.containerId) return { owned: true, container: null, runtimeVariableNames: Object.keys(runtime.variables).sort() };
  const name = assertOwnedContainerName(deployment);
  const owned = await verifyOwnedContainer(name);
  if (!owned) return { owned: false, container: null, runtimeVariableNames: Object.keys(runtime.variables).sort() };
  const container = await containerRuntime(deployment.containerId);
  return { owned: true, container, runtimeVariableNames: Object.keys(runtime.variables).sort(), secretNames: runtime.variables && Object.keys(runtime.variables).filter((variableName) => ["APP_KEY", "DB_PASSWORD"].includes(variableName)) };
}

export async function deploymentOwnedContainerName(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: { select: { slug: true } }, environment: { select: { slug: true } } } });
  if (!deployment) throw new Error("Deployment not found.");
  return ownedContainerName(deployment);
}

export { containerExists };
