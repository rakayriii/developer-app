import { prisma } from "@/lib/db";
import { runGit } from "@/lib/git/runner.ts";
import { deploymentRepository } from "./config";
import { buildImage, containerDiagnostics, containerName, containerExists, execReleaseCommand, healthCheck, imageExists, imageTag, portAvailable, startContainer, stopOwnedContainer, DeploymentDockerError } from "./docker";
import { discoverDockerfile } from "./dockerfile";
import { withDeploymentLock } from "./lock";
import { DeploymentConflictError } from "./errors";
import { hasDeploymentInProgress } from "./state";
import { redactSecrets } from "./runtime-env";
import { resolveRuntimeEnvironment } from "./runtime-store";

const maxLogBytes = Number(process.env.DEPLOYMENT_MAX_LOG_BYTES || 256 * 1024);
async function log(deploymentId: string, stream: string, message: string, secretValues: readonly string[] = []) { const bounded = redactSecrets(message, secretValues).slice(0, 2000); await prisma.deploymentLog.create({ data: { deploymentId, stream, message: bounded } }).catch(() => undefined); const logs = await prisma.deploymentLog.findMany({ where: { deploymentId }, orderBy: { timestamp: "desc" }, select: { id: true, message: true } }).catch(() => []); let total = logs.reduce((sum, item) => sum + item.message.length, 0); for (const item of logs.slice(1000)) { await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } if (total > maxLogBytes) { for (const item of logs.reverse()) { if (total <= maxLogBytes) break; await prisma.deploymentLog.delete({ where: { id: item.id } }).catch(() => undefined); total -= item.message.length; } } }
async function repositoryState(project: { localRepositoryPath: string | null }) { const { repositoryRoot } = await deploymentRepository(project.localRepositoryPath); const dockerfile = await discoverDockerfile(repositoryRoot); const status = await runGit(["status", "--porcelain"], repositoryRoot); if (status.stdout.trim()) throw new DeploymentDockerError("dirty_repository", "Deployment requires a clean Git working tree.", 409); const commitSha = (await runGit(["rev-parse", "HEAD"], repositoryRoot)).stdout.trim(); const branch = (await runGit(["branch", "--show-current"], repositoryRoot)).stdout.trim() || null; return { repositoryRoot, dockerfile, commitSha, branch }; }

type Stage = "build" | "container_startup" | "port" | "release_command" | "health_check";
class StagedFailure extends Error { stage: Stage; code: string; status = 409; constructor(stage: Stage, message: string, code = "health_check_failed") { super(message); this.stage = stage; this.code = code; } }

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
    let stage: Stage = "build";
    try {
      const state = await repositoryState(current.project);
      await prisma.deployment.update({ where: { id: current.id }, data: { commitSha: state.commitSha, branch: state.branch, dockerfile: state.dockerfile.name, status: "building", startedAt: new Date(), errorMessage: null } });
      await log(current.id, "system", `Build started for ${state.commitSha.slice(0, 12)}.`, runtime.secretValues);
      await log(current.id, "system", `Dockerfile: ${state.dockerfile.name}`, runtime.secretValues);
      await log(current.id, "system", `Runtime variables configured: ${Object.keys(runtime.variables).sort().join(", ") || "none"} (values are never logged).`, runtime.secretValues);
      if (runtime.unreadable.length) throw new StagedFailure("build", `Stored secrets could not be decrypted: ${runtime.unreadable.join(", ")}.`, "runtime_secret_unreadable");
      const buildOutput = await buildImage(state.repositoryRoot, state.dockerfile.path, current.imageTag, (chunk) => { void log(current.id, "build", chunk, runtime.secretValues); });
      if (buildOutput) await log(current.id, "build", "Docker image build completed.", runtime.secretValues);
      stage = "port";
      if (!await portAvailable(current.environment.hostPort)) throw new StagedFailure("port", `Host port ${current.environment.hostPort} is already in use.`, "port_in_use");
      stage = "container_startup";
      await prisma.deployment.update({ where: { id: current.id }, data: { status: "starting" } });
      const name = containerName(current.project.slug, current.environment.slug, current.id);
      newContainer = await startContainer({ tag: current.imageTag, name, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, environment: runtime.variables });
      await prisma.deployment.update({ where: { id: current.id }, data: { containerId: newContainer, containerName: name } });
      await log(current.id, "container", `Container ${name} started.`, runtime.secretValues);
      if (current.environment.runMigrations) {
        stage = "release_command";
        await log(current.id, "release", "Running database migrations.", runtime.secretValues);
        await execReleaseCommand(newContainer, "migrate", (chunk) => { void log(current.id, "release", chunk, runtime.secretValues); });
        await log(current.id, "release", "Database migrations completed.", runtime.secretValues);
      }
      stage = "health_check";
      const health = await healthCheck(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries);
      if (!health.healthy) {
        await log(current.id, "health", `Health check URL: ${health.url}`, runtime.secretValues);
        await log(current.id, "health", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, runtime.secretValues);
        if (health.bodyExcerpt) await log(current.id, "health", `Response excerpt: ${health.bodyExcerpt}`, runtime.secretValues);
        throw new StagedFailure("health_check", health.message, "health_check_failed");
      }
      await log(current.id, "health", health.message, runtime.secretValues);
      const previous = await prisma.deployment.findFirst({ where: { environmentId: current.environmentId, status: "running", id: { not: current.id } }, orderBy: { createdAt: "desc" } });
      await prisma.deployment.update({ where: { id: current.id }, data: { status: "running", healthStatus: "healthy", finishedAt: new Date() } });
      if (previous?.containerId) { await prisma.deployment.update({ where: { id: previous.id }, data: { status: "stopping", finishedAt: new Date() } }); await stopOwnedContainer(previous.containerId); await prisma.deployment.update({ where: { id: previous.id }, data: { status: "stopped" } }); }
      return prisma.deployment.findUnique({ where: { id: current.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Deployment failed.";
      if (newContainer) {
        const diagnostics = await containerDiagnostics(newContainer).catch(() => ({ state: "unknown", logs: "" }));
        await log(current.id, "diagnostics", `Container state: ${diagnostics.state}`, runtime.secretValues);
        if (diagnostics.logs) await log(current.id, "diagnostics", `Container logs (tail):\n${diagnostics.logs}`, runtime.secretValues);
      }
      const failedStage = error instanceof StagedFailure ? error.stage : stage;
      await log(current.id, "error", `[${failedStage}] ${message}`, runtime.secretValues);
      await prisma.deployment.update({ where: { id: current.id }, data: { status: "failed", healthStatus: "unhealthy", errorMessage: `[${failedStage}] ${message}`, finishedAt: new Date() } });
      if (newContainer) await stopOwnedContainer(newContainer);
      throw error;
    }
  });
}

export async function rollbackDeployment(deploymentId: string) { const current = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true, environment: true } }); if (!current) throw new Error("Deployment not found."); const previous = await prisma.deployment.findFirst({ where: { environmentId: current.environmentId, status: { in: ["running", "stopped"] }, id: { not: current.id } }, orderBy: { createdAt: "desc" } }); if (!previous || !(await imageExists(previous.imageTag))) throw new DeploymentDockerError("rollback_unavailable", "No previous deployment image is available for rollback.", 409); const rollback = await prisma.deployment.create({ data: { projectId: current.projectId, environmentId: current.environmentId, commitSha: previous.commitSha, branch: previous.branch, imageTag: previous.imageTag, rollbackOfId: current.id, status: "starting" } }); return withDeploymentLock(current.projectId, current.environmentId, async () => { const runtime = await resolveRuntimeEnvironment(current.environmentId); let container = ""; try { if (!await portAvailable(current.environment.hostPort)) throw new DeploymentDockerError("port_in_use", "Host port is already in use.", 409); const name = containerName(current.project.slug, current.environment.slug, rollback.id); container = await startContainer({ tag: rollback.imageTag, name, hostPort: current.environment.hostPort, containerPort: current.environment.containerPort, cpuLimit: current.environment.cpuLimit, memoryLimit: current.environment.memoryLimit, environment: runtime.variables }); await prisma.deployment.update({ where: { id: rollback.id }, data: { containerId: container, containerName: name } }); if (current.environment.runMigrations) await execReleaseCommand(container, "migrate", (chunk) => { void log(rollback.id, "release", chunk, runtime.secretValues); }); const health = await healthCheck(current.environment.hostPort, current.environment.healthPath, current.environment.healthTimeoutMs, current.environment.healthRetries); if (!health.healthy) { await log(rollback.id, "health", `Health check URL: ${health.url}`, runtime.secretValues); await log(rollback.id, "health", `Health check result: ${health.message}${health.transportError ? ` (${health.transportError})` : ""}`, runtime.secretValues); if (health.bodyExcerpt) await log(rollback.id, "health", `Response excerpt: ${health.bodyExcerpt}`, runtime.secretValues); throw new DeploymentDockerError("health_failed", health.message, 409); } await prisma.deployment.update({ where: { id: rollback.id }, data: { status: "running", healthStatus: "healthy", finishedAt: new Date() } }); if (current.containerId) await stopOwnedContainer(current.containerId); await prisma.deployment.update({ where: { id: current.id }, data: { status: "rolled_back", finishedAt: new Date() } }); return rollback; } catch (error) { if (container) { const diagnostics = await containerDiagnostics(container).catch(() => ({ state: "unknown", logs: "" })); await log(rollback.id, "diagnostics", `Container state: ${diagnostics.state}`, runtime.secretValues); if (diagnostics.logs) await log(rollback.id, "diagnostics", `Container logs (tail):\n${diagnostics.logs}`, runtime.secretValues); } const message = error instanceof Error ? error.message : "Rollback failed."; await log(rollback.id, "error", message, runtime.secretValues); await prisma.deployment.update({ where: { id: rollback.id }, data: { status: "failed", errorMessage: message, finishedAt: new Date() } }); if (container) await stopOwnedContainer(container); throw error; } }); }

export async function stopDeployment(deploymentId: string) { const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } }); if (!deployment) throw new Error("Deployment not found."); return withDeploymentLock(deployment.projectId, deployment.environmentId, async () => { if (deployment.containerId && await containerExists(deployment.containerId)) await stopOwnedContainer(deployment.containerId); return prisma.deployment.update({ where: { id: deployment.id }, data: { status: "stopped", finishedAt: new Date() } }); }); }
