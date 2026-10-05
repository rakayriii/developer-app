import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

// Fixed, non-configurable limits. The browser can never influence any of these.
export const sshConnectionTimeoutMs = 10000;
export const sshCommandTimeoutMs = 10000;
export const sshMaxOutputBytes = 256 * 1024;
export const sshKeyscanTimeoutMs = 10000;

export const serverStatuses = ["unknown", "online", "offline", "error"] as const;
export type ServerStatus = (typeof serverStatuses)[number];

export const serverErrorCodes = ["ssh_connection_failed", "authentication_failed", "host_unreachable", "command_timeout", "docker_unavailable", "permission_denied", "host_key_mismatch", "host_key_untrusted", "ssh_unavailable"] as const;
export type ServerErrorCode = (typeof serverErrorCodes)[number];

export class SshError extends Error {
  code: ServerErrorCode;
  status: number;

  constructor(code: ServerErrorCode, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Fixed probe allowlist. Each entry is a literal argument array executed without a local shell, and
// every remote command is a constant here. There is no generic command entry point anywhere in the
// codebase, so no caller-supplied string can ever reach a remote shell.
const remoteProbes: Readonly<Record<string, string>> = Object.freeze({
  // Emits exactly "PRETTY_NAME|VERSION_ID" on one line so quoted values containing spaces survive.
  // grep is used rather than sourcing so a missing or hostile os-release cannot alter this shell.
  os: "grep -E '^(PRETTY_NAME|NAME|VERSION_ID)=' /etc/os-release 2>/dev/null | sort | tr '\\n' '|'",
  arch: "uname -m",
  kernel: "uname -sr",
  cpu: "getconf _NPROCESSORS_ONLN 2>/dev/null || nproc",
  memory: "awk '/MemTotal/ {print $2 * 1024; exit}' /proc/meminfo",
  disk: "df -B1 --output=size,avail / 2>/dev/null | tail -1",
  docker: "command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' 2>/dev/null || echo NONE",
});

export type ProbeName = keyof typeof remoteProbes;
export const probeNames = Object.keys(remoteProbes) as ProbeName[];

export function probeScript(probe: ProbeName) {
  const script = remoteProbes[probe];
  if (typeof script !== "string") throw new SshError("command_timeout", "Unknown probe.", 400);
  return script;
}

export function classifySshFailure(stderr: string, timedOut: boolean) {
  const text = stderr.toLowerCase();
  if (timedOut) return { code: "command_timeout" as const, message: `SSH command timed out after ${sshCommandTimeoutMs} ms.` };
  if (text.includes("host key verification failed") || text.includes("remote host identification has changed") || text.includes("host key for")) return { code: "host_key_mismatch" as const, message: "The remote host key does not match the trusted fingerprint." };
  if (text.includes("no route to host") || text.includes("connection timed out") || text.includes("operation timed out") || text.includes("network is unreachable")) return { code: "host_unreachable" as const, message: "The host could not be reached." };
  if (text.includes("connection refused")) return { code: "ssh_connection_failed" as const, message: "The host refused the SSH connection." };
  if (text.includes("could not resolve hostname") || text.includes("name or service not known")) return { code: "host_unreachable" as const, message: "The host name could not be resolved." };
  if (text.includes("permission denied") && (text.includes("publickey") || text.includes("authentication"))) return { code: "authentication_failed" as const, message: "SSH authentication was rejected." };
  if (text.includes("permission denied")) return { code: "permission_denied" as const, message: "The remote user does not have permission to run the system probe." };
  if (text.includes("no matching host key") || text.includes("host key is not known")) return { code: "host_key_mismatch" as const, message: "The remote host key does not match the trusted fingerprint." };
  return { code: "ssh_connection_failed" as const, message: "The SSH connection failed." };
}

// Remote stderr is summarised for the check log. Long opaque blobs are masked so a key or token can
// never reach a stored record or a response body.
export function safeDiagnostic(stderr: string) {
  // A whole PEM block is dropped before line handling, so no key body line can survive masking.
  const withoutBlocks = stderr.replace(/-{2,}[A-Z ]*PRIVATE KEY-{2,}[\s\S]*?-{2,}[A-Z ]*PRIVATE KEY-{2,}/g, "[redacted-key]");
  return withoutBlocks
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((line) => line.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, "[redacted]").slice(0, 300))
    .join(" | ");
}

export type ExecResult = { stdout: string; stderr: string; code: number; timedOut: boolean };

export function runProcess(file: string, args: string[], timeoutMs: number, maxBuffer = sshMaxOutputBytes, input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    // Output is read from the execFile callback only. Accumulating in stream handlers as well would
    // double-count and truncate the result.
    const child = execFile(file, args, { shell: false, timeout: 0, maxBuffer }, (error, out, err) => {
      clearTimeout(timer);
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 255 : 0;
      resolve({ stdout: (out || "").slice(0, sshMaxOutputBytes), stderr: (err || "").slice(0, 4096), code, timedOut });
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000); }, timeoutMs);
    child.once("close", () => clearTimeout(timer));
    if (input !== undefined) child.stdin?.end(input);
  });
}

// Many OpenSSH utilities print their version banner to stderr and exit 0; ssh-keyscan has no -V and
// exits 0 with usage output. Availability is therefore decided by "the binary ran", not by exit code.
export async function hasBinary(file: string) {
  try {
    await execFile(file, ["-V"], { shell: false, timeout: 5000, maxBuffer: 4096 });
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? false : true;
  }
}

export type HostKey = { fingerprint: string; keyType: string; knownHostsLine: string };

// Reads the host key the server presents and derives its SHA256 fingerprint. Nothing is persisted
// here; the caller decides whether to trust it.
export async function scanHostKey(hostname: string, port: number): Promise<HostKey> {
  if (!(await hasBinary("ssh-keyscan"))) throw new SshError("ssh_unavailable", "The OpenSSH client is not available on this host.", 503);
  const args = ["-p", String(port), "-T", "3", "-t", "ed25519,ecdsa,rsa", hostname];
  const result = await runProcess("ssh-keyscan", args as string[], sshKeyscanTimeoutMs, 64 * 1024);
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (!lines.length) throw new SshError("host_unreachable", "The host did not present an SSH host key.", 502);
  // The fingerprint is derived from the exact same key line that will be pinned in known_hosts, so
  // the recorded fingerprint can never describe a different key than the one enforced.
  const knownHostsLine = lines[0];
  const fingerprintResult = await runProcess("ssh-keygen", ["-lf", "-", "-E", "sha256"], 5000, 4096, `${knownHostsLine}\n`);
  const match = fingerprintResult.stdout.match(/SHA256:([A-Za-z0-9+/=]+)/);
  const parts = knownHostsLine.split(/\s+/);
  return { fingerprint: match ? `SHA256:${match[1].replace(/=+$/, "")}` : "", keyType: parts[1] || "unknown", knownHostsLine };
}

export type HostKeyScan = { fingerprint: string; keyType: string; knownHostsLine: string };

function parseFingerprint(keyLine: string) {
  const parts = keyLine.split(/\s+/);
  return { keyType: parts[1] || "unknown" };
}

export async function fingerprintOfLine(keyLine: string) {
  const result = await runProcess("ssh-keygen", ["-lf", "-", "-E", "sha256"], 5000, 4096, `${keyLine}\n`);
  const match = result.stdout.match(/SHA256:([A-Za-z0-9+/=]+)/);
  return match ? `SHA256:${match[1].replace(/=+$/, "")}` : "";
}

// Preferred trust path: a real authenticated connection that also records the presented key. Using
// accept-new against a throwaway known_hosts means sshd sees a normal authenticated login rather
// than an unauthenticated keyscan probe, which many servers penalise.
export async function scanHostKeyWithCredential(hostname: string, port: number, username: string, privateKey: string): Promise<HostKeyScan | null> {
  if (!(await hasBinary("ssh"))) return null;
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-os-trust-"));
  const keyPath = path.join(directory, "id");
  const knownHostsPath = path.join(directory, "known_hosts");
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  await writeFile(knownHostsPath, "", { mode: 0o600 });
  try {
    const result = await runProcess("ssh", [
      "-i", keyPath, "-p", String(port),
      "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "PreferredAuthentications=publickey", "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "UserKnownHostsFile=" + knownHostsPath,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "RequestTTY=no", "-o", "ForwardAgent=no",
      `${username}@${hostname}`, "true",
    ], sshConnectionTimeoutMs);
    if (result.code !== 0) return null;
    const line = (await readFile(knownHostsPath, "utf8")).split("\n").map((entry) => entry.trim()).find((entry) => entry && !entry.startsWith("#"));
    if (!line) return null;
    return { fingerprint: await fingerprintOfLine(line), keyType: parseFingerprint(line).keyType, knownHostsLine: line };
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type ConnectOptions = { hostname: string; port: number; username: string; privateKey: string; hostKeyLine: string };

export type SshSession = { exec: (probe: ProbeName) => Promise<string>; close: () => Promise<void> };

// Opens a short-lived session whose host key is pinned to the exact line the server presented, with
// StrictHostKeyChecking=yes. Verification is therefore enforced on every single command.
export async function connect(options: ConnectOptions): Promise<SshSession> {
  if (!(await hasBinary("ssh"))) throw new SshError("ssh_unavailable", "The OpenSSH client is not available on this host.", 503);
  if (!options.hostKeyLine.trim()) throw new SshError("host_key_untrusted", "Trust this host key before connecting.", 428);
  const directory = await mkdtemp(path.join(os.tmpdir(), "developer-os-ssh-"));
  const keyPath = path.join(directory, "id_ed25519");
  const knownHostsPath = path.join(directory, "known_hosts");
  await writeFile(keyPath, options.privateKey, { mode: 0o600 });
  await writeFile(knownHostsPath, `${options.hostKeyLine}\n`, { mode: 0o600 });

  const base = [
    "-i", keyPath,
    "-p", String(options.port),
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "PreferredAuthentications=publickey",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UserKnownHostsFile=" + knownHostsPath,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
  ];
  const target = `${options.username}@${options.hostname}`;

  const cleanup = async () => { await rm(directory, { recursive: true, force: true }); };
  const run = async (script: string) => {
    // A single SSH invocation, a single fixed script, and a single line of stdout. Some hosts emit a
    // login banner on stdout, so only the final non-empty line is accepted.
    const result = await runProcess("ssh", [...base, target, script], sshCommandTimeoutMs);
    if (result.timedOut) throw new SshError("command_timeout", `SSH command timed out after ${sshCommandTimeoutMs} ms.`, 504);
    if (result.code !== 0) {
      const failure = classifySshFailure(result.stderr, false);
      throw new SshError(failure.code, failure.message, 502);
    }
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "";
  };

  // The handshake is retried briefly because sshd enforces per-source connection limits and can
  // refuse a burst even from a legitimate client. Only transient refusals are retried; an
  // authentication or host-key failure is returned immediately.
  const handshake = async () => {
    let last: SshError | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await run(probeScript("arch")); }
      catch (error) {
        if (!(error instanceof SshError)) throw error;
        last = error;
        if (error.code !== "ssh_connection_failed" && error.code !== "host_unreachable") throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw last ?? new SshError("ssh_connection_failed", "The SSH connection failed.", 502);
  };

  try {
    await handshake();
  } catch (error) {
    await cleanup();
    throw error;
  }

  return {
    exec: async (probe: ProbeName) => run(probeScript(probe)),
    close: cleanup,
  };
}
