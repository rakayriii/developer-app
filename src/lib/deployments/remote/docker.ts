import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { deploymentDockerTimeoutMs } from "@/lib/docker/client.ts";
import type { SshTransport } from "@/lib/servers/ssh.ts";
import { RemoteDeploymentError } from "./server.ts";
import { summarizeRemoteFailure } from "./diagnostics.ts";
import {
  REMOTE_IMAGE_LOAD_COMMAND,
  assertRemoteImage,
  assertRemoteName,
  assertRemotePath,
  healthTarget,
  remoteContainerDiagnosticsCommand,
  remoteContainerExistsCommand,
  remoteContainerLogsCommand,
  remoteContainerPortsCommand,
  remoteContainerRuntimeCommand,
  remoteContainerStatsCommand,
  remoteHealthExcerptCommand,
  remoteHealthStatusCommand,
  remoteImageInspectCommand,
  remoteMigrationCommand,
  remotePortOwnerCommand,
  remoteRemoveCommand,
  remoteRemoveEnvFileCommand,
  remoteRestartCommand,
  remoteStartCommand,
  remoteStopCommand,
  remoteStopGraceSeconds,
  remoteWriteEnvFileCommand,
} from "./args.ts";

// Bounded transfer. A remote deployment transfers a real image, so the allowance is generous, but it
// is still a hard ceiling rather than "whatever docker save happens to produce".
export const remoteTransferMaxBytes = Number(process.env.REMOTE_TRANSFER_MAX_BYTES || 4 * 1024 * 1024 * 1024);
export const remoteTransferTimeoutMs = Number(process.env.REMOTE_TRANSFER_TIMEOUT_MS || 900000);

const lastLine = (stdout: string) => stdout.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";

/**
 * Runs one fixed remote command. An SSH failure is translated into the deployment error contract so
 * callers never have to know which layer failed.
 *
 * The remote diagnostic is preserved in the message. Swallowing it would make every remote failure
 * read as the same generic sentence, which is exactly the kind of opaque error this codebase avoids.
 *
 * `input` streams a string into the remote command's stdin. That is how the runtime environment file
 * is written; the values never appear in the argument vector.
 */
async function remote(transport: SshTransport, command: string, options?: { timeoutMs?: number; maxBytes?: number; input?: string; failureCode?: string; failureMessage?: string }) {
  try {
    if (options?.input !== undefined) {
      const result = await transport.pipe(command, Readable.from([Buffer.from(options.input, "utf8")]), { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes ?? 64 * 1024 });
      return { stdout: result.stdout, stderr: result.stderr };
    }
    return await transport.run(command, { timeoutMs: options?.timeoutMs, maxBytes: options?.maxBytes });
  } catch (error) {
    const failure = error as { code?: string; message?: string; status?: number };
    const detail = summarizeRemoteFailure(failure.message ?? "");
    const summary = options?.failureMessage ?? "The remote command failed.";
    throw new RemoteDeploymentError(options?.failureCode ?? failure.code ?? "ssh_connection_failed", detail ? `${summary} ${detail}` : summary, failure.status ?? 502);
  }
}


// ---------------------------------------------------------------------------------------------
// Image transfer
// ---------------------------------------------------------------------------------------------

/**
 * Streams a locally built image into the remote Docker daemon.
 *
 * `docker save` is spawned locally and its stdout is piped straight into the SSH process's stdin,
 * where the remote side runs the fixed command `docker load`. No shell exists anywhere in this path:
 * `shell` is never enabled, the local side is a direct child process, the two are joined by a pipe
 * rather than a shell pipeline, and the remote command is a module constant. No intermediate archive
 * is ever written to disk, so the image never lands in a world-readable temporary file.
 */
export async function remoteDockerLoad(transport: SshTransport, tag: string, onProgress?: (bytes: number) => void) {
  const image = assertRemoteImage(tag);
  const host = process.env.DOCKER_SOCKET_PATH;
  const args = [...(host ? ["-H", `unix://${host}`] : []), "save", image];

  let transferred = 0;
  let overflowed = false;
  const source = spawn("docker", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const imageStream = source.stdout;
  source.stdout.on("data", (chunk: Buffer) => {
    transferred += chunk.length;
    if (transferred > remoteTransferMaxBytes && !overflowed) { overflowed = true; source.kill("SIGTERM"); }
    onProgress?.(transferred);
  });

  const localFailure = new Promise<never>((_, reject) => {
    source.once("error", (error) => reject(new RemoteDeploymentError((error as { code?: string }).code === "ENOENT" ? "docker_unavailable" : "transfer_failed", "The local Docker CLI could not export the image for transfer.", 503)));
  });

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await Promise.race([transport.pipe(REMOTE_IMAGE_LOAD_COMMAND, imageStream, { timeoutMs: remoteTransferTimeoutMs, maxBytes: 256 * 1024 }), localFailure]);
  } finally {
    if (!source.killed) source.kill("SIGTERM");
  }

  if (overflowed) throw new RemoteDeploymentError("transfer_too_large", `The image exceeds the ${remoteTransferMaxBytes} byte transfer limit.`, 409);
  if (result.code !== 0) throw new RemoteDeploymentError("transfer_failed", `The remote host rejected the image: ${lastLine(result.stderr) || "docker load failed"}`, 502);
  return { bytes: transferred, output: result.stdout.trim() };
}

export async function remoteDockerImageExists(transport: SshTransport, tag: string) {
  try {
    await remote(transport, remoteImageInspectCommand(tag));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Runtime environment file
// ---------------------------------------------------------------------------------------------

/**
 * Writes the runtime environment to a 0600 file on the remote host. This is what keeps a secret out
 * of the remote process table: values are never passed as `docker run -e KEY=VALUE` arguments, and
 * `remoteRemoveEnvironmentFile` deletes the file before the container is started.
 */
export async function remoteWriteEnvironmentFile(transport: SshTransport, path: string, contents: string) {
  const target = assertRemotePath(path);
  if (!contents || !contents.trim()) throw new RemoteDeploymentError("runtime_secret_unreadable", "No runtime environment was resolved for this deployment.", 409);
  await remote(transport, remoteWriteEnvFileCommand(target), { input: contents, failureCode: "runtime_env_write_failed", failureMessage: "The runtime environment could not be written to the remote host." });
  return target;
}

export async function remoteRemoveEnvironmentFile(transport: SshTransport, path: string) {
  await remote(transport, remoteRemoveEnvFileCommand(path)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------------------------

export async function remoteContainerExists(transport: SshTransport, name: string) {
  const result = await remote(transport, remoteContainerExistsCommand(name));
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).includes(assertRemoteName(name));
}

/**
 * Which container, if any, publishes this host port. Read-only, and the basis for deciding whether a
 * port collision belongs to Developer OS or to something else entirely.
 */
export async function remotePortOwner(transport: SshTransport, port: number) {
  const result = await remote(transport, remotePortOwnerCommand(port));
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? null;
}

export async function remoteDockerCreate(transport: SshTransport, command: string) {
  const result = await remote(transport, command, { failureCode: "container_startup_failed", failureMessage: "The remote host could not create the container." });
  return lastLine(result.stdout);
}

export async function remoteDockerStart(transport: SshTransport, name: string) {
  await remote(transport, remoteStartCommand(name), { timeoutMs: lifecycleTimeoutMs, failureCode: "container_startup_failed", failureMessage: "The remote container could not be started." });
}

// A stop must allow the container its full grace period, and a restart must allow that plus the start.
// Both bounds are server-side constants: the browser cannot influence either.
const lifecycleTimeoutMs = (remoteStopGraceSeconds + 25) * 1000;

export async function remoteDockerStop(transport: SshTransport, name: string) {
  await remote(transport, remoteStopCommand(name), { timeoutMs: lifecycleTimeoutMs, failureCode: "container_stop_failed", failureMessage: "The remote container could not be stopped." });
}

export async function remoteDockerRemove(transport: SshTransport, name: string) {
  await remote(transport, remoteRemoveCommand(name)).catch(() => undefined);
}

export async function remoteDockerRestart(transport: SshTransport, name: string) {
  await remote(transport, remoteRestartCommand(name), { timeoutMs: lifecycleTimeoutMs, failureCode: "container_restart_failed", failureMessage: "The remote container could not be restarted." });
}

// ---------------------------------------------------------------------------------------------
// Fixed release command
// ---------------------------------------------------------------------------------------------

/** Runs the one supported release operation. The argv sequence is a constant; nothing is parameterised. */
export async function remoteDockerExecMigration(transport: SshTransport, name: string, onOutput?: (chunk: string) => void) {
  const result = await remote(transport, remoteMigrationCommand(name), { timeoutMs: deploymentDockerTimeoutMs(), maxBytes: 1024 * 1024, failureCode: "release_command_failed", failureMessage: "The release command failed on the remote host." });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) onOutput?.(output);
  return output;
}

// ---------------------------------------------------------------------------------------------
// Health verification
// ---------------------------------------------------------------------------------------------

export type RemoteHealthResult = { healthy: boolean; message: string; url: string; status: number | null; bodyExcerpt: string | null; transportError: string | null };

/**
 * Verifies health *on the remote host* over the pinned SSH connection. The Developer OS process never
 * fetches the remote URL itself, so a hostile port or path cannot be used to reach an arbitrary
 * address from this machine. curl presence is confirmed by a capability probe before this is used.
 */
export async function remoteHealthCheck(transport: SshTransport, port: number, healthPath: string, retries: number, timeoutMs: number) {
  const url = healthTarget(port, healthPath);
  let last: Omit<RemoteHealthResult, "healthy" | "url"> = { message: "Health check did not succeed.", status: null, bodyExcerpt: null, transportError: null };
  const deadline = Date.now() + deploymentDockerTimeoutMs();

  for (let attempt = 0; attempt < retries && Date.now() < deadline; attempt += 1) {
    try {
      const result = await remote(transport, remoteHealthStatusCommand(port, healthPath), { timeoutMs: Math.max(1000, Math.min(timeoutMs + 5000, 30000)) });
      const status = Number.parseInt(lastLine(result.stdout), 10);
      if (Number.isInteger(status) && status >= 200 && status < 400) return { healthy: true, message: `HTTP ${status}`, url, status, bodyExcerpt: null, transportError: null };
      last = { message: Number.isInteger(status) ? `Health check returned HTTP ${status} from ${url}` : `Health check did not return a status from ${url}`, status: Number.isInteger(status) ? status : null, bodyExcerpt: null, transportError: null };
    } catch (error) {
      const failure = error as { code?: string };
      last = { message: `Health check received no HTTP response from ${url}`, status: null, bodyExcerpt: null, transportError: failure.code ?? "transport_error" };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))));
  }

  const excerpt = await remote(transport, remoteHealthExcerptCommand(port, healthPath), { timeoutMs: 15000 }).then((result) => result.stdout).catch(() => "");
  last = { ...last, bodyExcerpt: excerpt.replace(/\s+/g, " ").trim().slice(0, 500) || null };
  return { healthy: false, ...last, url };
}

// ---------------------------------------------------------------------------------------------
// Runtime projection and diagnostics
// ---------------------------------------------------------------------------------------------

export type RemoteContainerRuntime = { state: string; running: boolean; health: string; restartCount: number; startedAt: string; image: string; restartPolicy: string; ports: string; cpuPercent: string; memoryUsage: string; memoryPercent: string };

/**
 * Bounded, allowlisted projection. The remote `docker inspect` document is never returned to the
 * browser: only these named fields are requested, and no environment, command line, mount, or label
 * is ever read, let alone returned.
 */
export async function remoteContainerRuntime(transport: SshTransport, name: string): Promise<RemoteContainerRuntime | null> {
  const inspected = await remote(transport, remoteContainerRuntimeCommand(name)).then((result) => lastLine(result.stdout)).catch(() => "");
  if (!inspected) return null;
  const [state = "unknown", running = "false", health = "none", restartCount = "0", startedAt = "", image = "", restartPolicy = ""] = inspected.split(",");
  const stats = await remote(transport, remoteContainerStatsCommand(name)).then((result) => lastLine(result.stdout)).catch(() => "");
  const [cpuPercent = "-", memoryUsage = "-", memoryPercent = "-"] = stats ? stats.split(",") : [];
  const published = await remoteContainerPorts(transport, name);
  return { state, running: running === "true", health: health || "none", restartCount: Number.parseInt(restartCount, 10) || 0, startedAt, image, restartPolicy, ports: published, cpuPercent, memoryUsage, memoryPercent };
}

/**
 * Published port bindings as "containerPort -> hostPort". Only bindings that actually publish a host
 * port are reported; an internal-only container port is not.
 */
async function remoteContainerPorts(transport: SshTransport, name: string) {
  const result = await remote(transport, remoteContainerPortsCommand(name)).catch(() => null);
  if (!result) return "-";
  const bindings = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split("->").map((part) => part.trim()))
    .filter(([, host]) => /^[^:]+:\d{2,5}$/.test(host ?? ""))
    .map(([container, host]) => `${container.replace(/^0\.0\.0\.0:/, "")}=>${host.split(":").pop()}`);
  return [...new Set(bindings)].join(", ") || "-";
}

export type RemoteContainerDiagnostics = { state: string; logs: string };

/** Bounded failure evidence, captured before any cleanup so it survives. */
export async function remoteContainerDiagnostics(transport: SshTransport, name: string): Promise<RemoteContainerDiagnostics> {
  const state = await remote(transport, remoteContainerDiagnosticsCommand(name)).then((result) => lastLine(result.stdout)).catch(() => "");
  const logs = await remote(transport, remoteContainerLogsCommand(name)).then((result) => result.stdout).catch(() => "");
  return { state: state || "unknown", logs: logs.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").split("\n").filter(Boolean).slice(-40).join("\n") };
}
