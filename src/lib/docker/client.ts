import { request } from "node:http";
import { execFile } from "node:child_process";

type DockerResponse<T> = { statusCode: number; body: T };

export type DockerInfo = { serverVersion: string; apiVersion: string; containersRunning: number; containersStopped: number; images: number };
export type DockerContainer = { id: string; name: string; image: string; status: string; state: string; created: string; ports: string };

class DockerError extends Error {
  public code: "unavailable" | "permission_denied" | "timeout" | "malformed" | "http";
  public status: number;

  constructor(code: "unavailable" | "permission_denied" | "timeout" | "malformed" | "http", message: string, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export { DockerError };

export const DEFAULT_DEPLOYMENT_DOCKER_TIMEOUT_MS = 600000;
export const MAX_DEPLOYMENT_DOCKER_TIMEOUT_MS = 600000;
export const MIN_DEPLOYMENT_DOCKER_TIMEOUT_MS = 1000;

export function deploymentDockerTimeoutMs() {
  const configured = Number(process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS || DEFAULT_DEPLOYMENT_DOCKER_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_DEPLOYMENT_DOCKER_TIMEOUT_MS;
  return Math.min(MAX_DEPLOYMENT_DOCKER_TIMEOUT_MS, Math.max(MIN_DEPLOYMENT_DOCKER_TIMEOUT_MS, Math.floor(configured)));
}

type ProcessOptions = { maxBuffer: number; timeout: number; onOutput?: (chunk: string) => void; env?: NodeJS.ProcessEnv };
export function runSafeProcess(file: string, args: string[], options: ProcessOptions) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const child = execFile(file, args, { shell: false, timeout: 0, maxBuffer: options.maxBuffer, env: options.env || process.env }, (error, output, errorOutput) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      stdout += output || "";
      stderr += errorOutput || "";
      if (timedOut) { reject(new DockerError("timeout", "Docker operation timed out.", 504)); return; }
      if (error) { reject(error); return; }
      resolve({ stdout, stderr });
    });
    const emit = (chunk: Buffer, stream: "stdout" | "stderr") => { const text = chunk.toString(); if (stream === "stdout") stdout += text; else stderr += text; options.onOutput?.(text); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > options.maxBuffer) child.kill("SIGTERM"); };
    child.stdout?.on("data", (chunk: Buffer) => emit(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => emit(chunk, "stderr"));
    const timeoutTimer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000); }, options.timeout);
    child.once("close", () => clearTimeout(timeoutTimer));
  });
}

export async function runDockerCommand(args: string[], maxBuffer = 4 * 1024 * 1024, timeout = deploymentDockerTimeoutMs(), onOutput?: (chunk: string) => void) {
  const host = process.env.DOCKER_SOCKET_PATH;
  try { return await runSafeProcess("docker", [...(host ? ["-H", `unix://${host}`] : []), ...args], { shell: false, timeout, maxBuffer, onOutput, env: { ...process.env, DOCKER_BUILDKIT: "1", GIT_TERMINAL_PROMPT: "0" } } as ProcessOptions); }
  catch (error) { const value = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string; killed?: boolean; code?: string }; const output = `${value.stdout || ""}${value.stderr || ""}`.trim(); if (error instanceof DockerError) throw error; if (value.code === "ENOENT") throw new DockerError("unavailable", "Docker CLI is not available.", 503); if (value.killed || value.code === "ETIMEDOUT") throw new DockerError("timeout", "Docker operation timed out.", 504); throw new DockerError("http", output.split("\n").filter(Boolean).slice(-1)[0] || "Docker operation failed.", 409); }
}

function socketPath() {
  return process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
}

async function dockerRequest<T>(path: string): Promise<DockerResponse<T>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), path, method: "GET", headers: { Accept: "application/json" }, timeout: 5000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        let parsed: T;
        try { parsed = JSON.parse(body) as T; } catch { reject(new DockerError("malformed", "Docker returned an invalid response.", 502)); return; }
        resolve({ statusCode: response.statusCode || 502, body: parsed });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new DockerError("timeout", "Docker daemon did not respond in time.", 504)); });
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES") reject(new DockerError("permission_denied", "Docker access is not permitted.", 503));
      else if (error.code === "ENOENT" || error.code === "ECONNREFUSED") reject(new DockerError("unavailable", "Docker daemon is unavailable.", 503));
      else reject(new DockerError("unavailable", "Docker daemon is unavailable.", 503));
    });
    req.end();
  });
}

type DockerInfoResponse = { ServerVersion?: string; ApiVersion?: string; ContainersRunning?: number; ContainersStopped?: number; Images?: number };
type DockerVersionResponse = { ApiVersion?: string };
type DockerContainerResponse = { Id: string; Names?: string[]; Image: string; Status: string; State: string; Created: number; Ports?: { PublicPort?: number; PrivatePort?: number; Type?: string }[] };

function assertResponse<T>(response: DockerResponse<T>): T {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new DockerError("http", "Docker rejected the request.", response.statusCode === 403 ? 503 : 502);
  return response.body;
}

export async function getDockerInfo(): Promise<DockerInfo> {
  const [infoResponse, versionResponse] = await Promise.all([dockerRequest<DockerInfoResponse>("/info"), dockerRequest<DockerVersionResponse>("/version")]);
  const value = assertResponse(infoResponse);
  const version = assertResponse(versionResponse);
  return { serverVersion: value.ServerVersion || "Unknown", apiVersion: version.ApiVersion || value.ApiVersion || "Unknown", containersRunning: value.ContainersRunning || 0, containersStopped: value.ContainersStopped || 0, images: value.Images || 0 };
}

export async function getDockerContainers(): Promise<DockerContainer[]> {
  const values = assertResponse(await dockerRequest<DockerContainerResponse[]>("/containers/json?all=true"));
  if (!Array.isArray(values)) throw new DockerError("malformed", "Docker returned an invalid container list.", 502);
  return values.map((container) => ({ id: container.Id, name: container.Names?.[0]?.replace(/^\//, "") || container.Id.slice(0, 12), image: container.Image, status: container.Status, state: container.State, created: container.Created ? new Date(container.Created * 1000).toISOString() : "", ports: (container.Ports || []).map((port) => port.PublicPort ? `${port.PublicPort}:${port.PrivatePort}/${port.Type || "tcp"}` : `${port.PrivatePort}/${port.Type || "tcp"}`).join(", ") || "-" }));
}
