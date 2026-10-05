import net from "node:net";
import { deploymentDockerTimeoutMs, DockerError, runDockerCommand } from "../docker/client.ts";

export class DeploymentDockerError extends Error { code: string; status: number; constructor(code: string, message: string, status = 503) { super(message); this.code = code; this.status = status; } }
async function docker(args: string[], maxBuffer = 1024 * 1024, onOutput?: (chunk: string) => void, operation = "Docker operation") { try { return await runDockerCommand(args, maxBuffer, deploymentDockerTimeoutMs(), onOutput); } catch (error) { if (error instanceof DockerError) { const message = error.code === "timeout" ? `${operation} timed out after ${deploymentDockerTimeoutMs()} ms.` : error.message; throw new DeploymentDockerError(`docker_${error.code}`, message, error.status); } throw new DeploymentDockerError("docker_failed", `${operation} failed.`, 409); } }
export function imageTag(projectSlug: string, deploymentId: string) { return `developer-os/${projectSlug}:deployment-${deploymentId}`; }
export function containerName(projectSlug: string, environmentSlug: string, deploymentId: string) { return `developer-os-${projectSlug}-${environmentSlug}-${deploymentId.slice(0, 12)}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120); }
export async function buildImage(repositoryRoot: string, dockerfilePath: string, tag: string, onOutput?: (chunk: string) => void) { const result = await docker(["build", "-f", dockerfilePath, "-t", tag, repositoryRoot], 4 * 1024 * 1024, onOutput, "Docker build"); return `${result.stdout}${result.stderr}`; }
export async function imageExists(tag: string) { try { await docker(["image", "inspect", tag], 64 * 1024); return true; } catch { return false; } }
export async function portAvailable(port: number) { return new Promise<boolean>((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); }); }

export function containerRunArguments(options: { tag: string; name: string; hostPort: number; containerPort: number; cpuLimit: string; memoryLimit: string; environment: Record<string, string> }) {
  return ["run", "--detach", "--name", options.name, "--publish", `${options.hostPort}:${options.containerPort}`, "--cpus", options.cpuLimit, "--memory", options.memoryLimit, "--pids-limit", "256", "--restart", "unless-stopped", ...Object.entries(options.environment).map(([key, value]) => ["--env", `${key}=${value}`]).flat(), options.tag];
}

export async function startContainer(options: { tag: string; name: string; hostPort: number; containerPort: number; cpuLimit: string; memoryLimit: string; environment: Record<string, string>; onOutput?: (chunk: string) => void }) { const args = containerRunArguments({ ...options, environment: { PORT: String(options.containerPort), ...options.environment } }); const result = await docker(args, 256 * 1024, options.onOutput, "Container startup"); return result.stdout.trim().split("\n").pop() || ""; }

// Fixed server-side release commands. Callers may select one by key but never supply arguments.
export const releaseCommands = Object.freeze({ migrate: Object.freeze(["artisan", "migrate", "--force", "--no-interaction"]) });
export function releaseCommandArguments(containerId: string, releaseCommand: string) { const command = releaseCommands[releaseCommand as keyof typeof releaseCommands]; if (!command) throw new DeploymentDockerError("invalid_release_command", "Release command is not allowed.", 400); return ["exec", containerId, "php", ...command]; }
export async function execReleaseCommand(containerId: string, releaseCommand: string, onOutput?: (chunk: string) => void) { const result = await docker(releaseCommandArguments(containerId, releaseCommand), 1024 * 1024, onOutput, `Release command ${releaseCommand}`); return `${result.stdout}${result.stderr}`; }

export async function stopOwnedContainer(containerId: string) { await docker(["stop", "--time", "10", containerId], 128 * 1024).catch(() => undefined); await docker(["rm", containerId], 128 * 1024).catch(() => undefined); }
export async function containerExists(containerId: string) { try { await docker(["inspect", containerId], 128 * 1024); return true; } catch { return false; } }

// Restarts only the supplied owned container. No flags are client-controlled.
export async function restartOwnedContainer(containerId: string) { const result = await docker(["restart", "--time", "10", containerId], 256 * 1024, undefined, "Container restart"); return result.stdout.trim(); }

// Ownership proof: the generated container name must still exist and must match the recorded one.
export async function verifyOwnedContainer(expectedName: string) {
  const names = await docker(["ps", "-a", "--filter", `name=^/${expectedName}$`, "--format", "{{.Names}}"], 128 * 1024).then((result) => result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)).catch(() => [] as string[]);
  return names.includes(expectedName);
}

export function containerInspectArguments(containerId: string) { return ["inspect", "--format", "{{json .}}", containerId]; }

const runtimeFormat = "{{.State.Status}}|{{.State.Running}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.HostConfig.RestartPolicy.Name}}|{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{range $conf}}{{.HostIp}}:{{.HostPort}},{{end}} {{end}}";

export type ContainerRuntime = { state: string; running: boolean; health: string; restartCount: number; startedAt: string; image: string; restartPolicy: string; ports: string; cpuPercent: string; memoryUsage: string; memoryPercent: string };

// Bounded, allowlisted projection. Raw docker inspect output is never returned to the browser.
export async function containerRuntime(containerId: string): Promise<ContainerRuntime | null> {
  // docker can emit more than one line while a container is transitioning; only the first record is used.
  const inspected = await docker(["inspect", "--format", runtimeFormat, containerId], 64 * 1024).then((result) => result.stdout.trim().split("\n")[0]).catch(() => "");
  if (!inspected) return null;
  const [state = "unknown", running = "false", health = "none", restartCount = "0", startedAt = "", image = "", restartPolicy = "", ports = ""] = inspected.split("|");
  const stats = await docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}", containerId], 128 * 1024).then((result) => result.stdout.trim().split("\n")[0]).catch(() => "");
  const [cpuPercent = "-", memoryUsage = "-", memoryPercent = "-"] = stats ? stats.split("|") : [];
  // Only published bindings (which carry a host port) are surfaced; internal-only ports are dropped.
  const published = [...new Set((ports.match(/\d+\/(?:tcp|udp)=[^\s]*/g) || []).filter((entry) => /:\d{2,5}/.test(entry)).map((entry) => entry.replace(/,(:::[\d.,]+)/, "").replace(/,$/, "")))].join(", ") || "-";
  return { state, running: running === "true", health: health || "none", restartCount: Number.parseInt(restartCount, 10) || 0, startedAt, image, restartPolicy, ports: published, cpuPercent, memoryUsage, memoryPercent };
}

export type ContainerDiagnostics = { state: string; logs: string };
export async function containerDiagnostics(containerId: string): Promise<ContainerDiagnostics> {
  const state = await docker(["inspect", "--format", "{{.State.Status}} exit={{.State.ExitCode}} running={{.State.Running}}{{if .State.Error}} error={{.State.Error}}{{end}}", containerId], 64 * 1024).then((result) => result.stdout.trim()).catch(() => "");
  const logs = await docker(["logs", "--tail", "80", containerId], 256 * 1024).then((result) => `${result.stdout}${result.stderr}`).catch(() => "");
  return { state: state || "unknown", logs: redactControlCharacters(logs).split("\n").slice(-40).join("\n") };
}

export type HealthCheckResult = { healthy: boolean; message: string; url: string; status: number | null; bodyExcerpt: string | null; transportError: string | null };
export async function healthCheck(port: number, path: string, timeoutMs: number, retries: number): Promise<HealthCheckResult> {
  const url = `http://127.0.0.1:${port}${path}`;
  const deadline = Date.now() + deploymentDockerTimeoutMs();
  let last: Omit<HealthCheckResult, "healthy" | "url"> = { message: "Health check did not succeed.", status: null, bodyExcerpt: null, transportError: null };
  for (let attempt = 0; attempt < retries && Date.now() < deadline; attempt += 1) {
    const remaining = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
      const bodyExcerpt = await response.text().then(excerpt).catch(() => null);
      if (response.ok) return { healthy: true, message: `HTTP ${response.status}`, url, status: response.status, bodyExcerpt, transportError: null };
      last = { message: `Health check returned HTTP ${response.status} from ${url}`, status: response.status, bodyExcerpt, transportError: null };
    } catch (error) {
      last = { message: `Health check received no HTTP response from ${url}`, status: null, bodyExcerpt: null, transportError: describeTransportError(error) };
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
  }
  if (Date.now() >= deadline) last = { ...last, message: `Health check timed out after ${deploymentDockerTimeoutMs()} ms.` };
  return { healthy: false, ...last, url };
}

function describeTransportError(error: unknown) {
  const cause = (error as { cause?: { code?: string } } | null)?.cause?.code;
  const name = error instanceof Error ? error.name : "unknown";
  return cause ? `${name} (${cause})` : name;
}
function excerpt(text: string) { return redactControlCharacters(text).replace(/\s+/g, " ").trim().slice(0, 500); }
function redactControlCharacters(value: string) { return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " "); }
