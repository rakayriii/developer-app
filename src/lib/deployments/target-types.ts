import type { ContainerRuntime, HealthCheckResult } from "./docker.ts";
import type { Stage } from "./stages.ts";

// The operation contract and its shared types live in their own module so the local implementation, the
// remote implementation, and the engine can all depend on them without a circular import.

export type StartRequest = { projectSlug: string; environmentSlug: string; deploymentId: string; tag: string; hostPort: number; containerPort: number; cpuLimit: string; memoryLimit: string; variables: Record<string, string> };

export type StageLogger = (deploymentId: string, stage: Stage, message: string, secretValues?: readonly string[]) => Promise<void>;

export type HostPortRequest = { environmentId: string; excludeDeploymentId: string; hostPort: number };

/**
 * The single set of deployment operations, implemented twice: once against the local Docker daemon and
 * once against a remote host over pinned SSH.
 *
 * Every lifecycle function in the engine is written against this interface, so a local and a remote
 * deployment share one flow, one lifecycle state graph, one logging path, one ownership model, and one
 * health-check result shape rather than two unrelated deployment systems.
 */
export type DeploymentOps = {
  target: "local" | "remote";
  serverId: string | null;
  serverName: string | null;
  /** Releases the host port on this target. Only Developer OS containers are ever touched. */
  releaseHostPort(request: HostPortRequest, secretValues: readonly string[]): Promise<void>;
  /** Streams a locally built image to the target. A no-op for local, which already has the image. */
  transferImage(tag: string, secretValues: readonly string[]): Promise<void>;
  start(request: StartRequest): Promise<{ containerId: string; containerName: string }>;
  runRelease(containerRef: string): Promise<void>;
  verifyHealth(hostPort: number, healthPath: string, timeoutMs: number, retries: number): Promise<HealthCheckResult>;
  captureDiagnostics(deploymentId: string, containerRef: string): Promise<void>;
  stopContainer(containerId: string, containerName: string): Promise<void>;
  restartContainer(containerId: string, containerName: string): Promise<void>;
  containerExists(containerId: string, containerName: string): Promise<boolean>;
  runtime(containerId: string, containerName: string): Promise<ContainerRuntime | null>;
  /** Confirms the rollback image is still present on this target. */
  verifyRollbackImage(tag: string): Promise<boolean>;
  close(): Promise<void>;
};

/** The projection a deployment record must expose for a target to be resolved. */
export type TargetBinding = {
  id: string;
  environmentId: string;
  target: string;
  serverId: string | null;
  project: { slug: string; userId: string };
  environment: { serverId: string | null; hostPort: number };
};
