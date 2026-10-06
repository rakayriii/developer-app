// Remote command construction.
//
// ssh(1) concatenates the argument vector with spaces and the *remote login shell* re-parses the
// result, so a remote "argument array" is not automatically safe: a value containing a space, a
// quote, or a shell metacharacter would be re-interpreted on the far side. Two rules keep that from
// being reachable:
//
//   1. The command shape is a literal template in this file. Nothing outside this module decides what
//      operators appear in a remote command.
//   2. Every value substituted into a template must match a narrow, per-purpose character class.
//
// Because the only shell operators that ever appear are the ones written as literals below, a
// caller-supplied string cannot become an operator: it is either a validated value or rejected.

import { RemoteCommandError } from "./errors.ts";

export { RemoteCommandError };

const fail = (message: string): never => { throw new RemoteCommandError(message); };

/** Docker image reference: repository path plus an optional tag. */
const imagePattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?$/;

/** Docker container name. */
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/;

/** Absolute remote path for the short-lived runtime environment file. */
const pathPattern = /^\/[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,199}$/;

/** CPU and memory limits, matching what the environment validator already accepts. */
const cpuLimitPattern = /^\d+(?:\.\d{1,2})?$/;
const memoryLimitPattern = /^\d+(?:m|g)$/i;

/** Health path, using the same grammar the environment validator applies. */
const healthPathPattern = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

// A path beginning with "//" is protocol-relative. The authority in a health target is fixed to loopback,
// so this could not redirect the request anywhere, but it is never a legitimate health path and
// rejecting it removes any doubt about how the composed URL could be read.
const assertHealthPath = (value: unknown) => {
  const path = match(value, healthPathPattern, "Health path");
  if (path.startsWith("//")) fail("Health path is not a valid remote command value.");
  return path;
};

/**
 * Docker Go template fragment. Commas are deliberately excluded: `a,b` is what a shell expands as a
 * brace list, so a format string can never contain one. Pipes are excluded for the same reason and
 * because they would split the command.
 */
const dockerTemplatePattern = /^\{\{[A-Za-z0-9._]*\}\}(,\{\{[A-Za-z0-9._]*\}\})*$/;

const match = (value: unknown, pattern: RegExp, what: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${what} is not a valid remote command value.`);
  return value as string;
};

export const assertRemoteImage = (value: unknown) => match(value, imagePattern, "Image reference");
export const assertRemoteName = (value: unknown) => match(value, namePattern, "Container name");
export const assertRemotePath = (value: unknown) => {
  const path = match(value, pathPattern, "Remote path");
  if (path.includes("..")) fail("Remote path is not a valid remote command value.");
  return path;
};
export const assertCpuLimit = (value: unknown) => match(value, cpuLimitPattern, "CPU limit");
export const assertMemoryLimit = (value: unknown) => match(value, memoryLimitPattern, "Memory limit");
const assertTemplate = (value: unknown) => match(value, dockerTemplatePattern, "Docker format template");

export const isRemotePort = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535;
const assertPort = (value: unknown) => { if (!isRemotePort(value)) fail("Port is not valid."); return String(value); };

/**
 * Joins validated values into the single string ssh sends to the remote shell. Every value has
 * already been matched against a metacharacter-free character class by the assert helpers above, so
 * the space join cannot introduce an operator.
 */
export function remoteCommand(...args: string[]) {
  if (!args.length) fail("Remote command arguments are required.");
  return args.join(" ");
}

// Fixed release operations. A caller selects one by key and can never supply arguments, exactly as
// the local `releaseCommands` table works.
export const remoteReleaseCommands = Object.freeze({ migrate: Object.freeze(["artisan", "migrate", "--force", "--no-interaction"]) });

export type RemoteCreateOptions = {
  tag: string;
  name: string;
  hostPort: number;
  containerPort: number;
  cpuLimit: string;
  memoryLimit: string;
  envFilePath: string;
};

/**
 * `docker create` with the same hardening the local runner applies: no privileged mode, no host
 * networking, no mounts, no capabilities, no Docker socket, bounded CPU/memory/PIDs, and a
 * server-generated name.
 *
 * Runtime values arrive through `--env-file`, never as `--env KEY=VALUE`, so a secret never reaches
 * the remote process argument list where another user of the host could read it from `ps`.
 */
export const remoteCreateCommand = (options: RemoteCreateOptions) => remoteCommand(
  "docker", "create",
  "--name", assertRemoteName(options.name),
  "--publish", `${assertPort(options.hostPort)}:${assertPort(options.containerPort)}`,
  "--cpus", assertCpuLimit(options.cpuLimit),
  "--memory", assertMemoryLimit(options.memoryLimit),
  "--pids-limit", "256",
  "--restart", "unless-stopped",
  "--env-file", assertRemotePath(options.envFilePath),
  assertRemoteImage(options.tag),
);

/** `docker exec <name> php artisan migrate --force --no-interaction`. */
export const remoteMigrationCommand = (name: string, releaseCommand: keyof typeof remoteReleaseCommands = "migrate") => {
  const command = remoteReleaseCommands[releaseCommand];
  if (!command) fail("Release command is not allowed.");
  return remoteCommand("docker", "exec", assertRemoteName(name), "php", ...command);
};

/**
 * Health verification runs *on the remote host* over the trusted SSH connection, so neither the
 * browser nor the Developer OS process issues a request to a user-influenced address. The loopback
 * host is fixed here and only the validated port and path are substituted. curl is confirmed to exist
 * by a capability probe before this command is ever sent.
 */
export const healthTarget = (port: number, healthPath: string) => {
  const target = `127.0.0.1:${assertPort(port)}${assertHealthPath(healthPath)}`;
  // Belt and braces: the composed target must still look like exactly a loopback URL and a path.
  if (!/^127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(target)) fail("Health target is not valid.");
  return target;
};

export const remoteHealthStatusCommand = (port: number, healthPath: string) => remoteCommand(
  "curl", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "10", healthTarget(port, healthPath),
);

export const remoteHealthExcerptCommand = (port: number, healthPath: string) => remoteCommand(
  "curl", "--silent", "--max-time", "10", healthTarget(port, healthPath),
);

/** Capability probe: does the remote host have a usable curl for health verification? */
export const remoteCurlCapabilityCommand = remoteCommand("command", "-v", "curl");

/** Finds which container, if any, publishes the given host port. Read-only. */
export const remotePortOwnerCommand = (port: number) => remoteCommand(
  "docker", "ps", "--all", "--filter", `publish=${assertPort(port)}`, "--format", assertTemplate("{{.Names}}"),
);

export const remoteImageInspectCommand = (tag: string) => remoteCommand("docker", "image", "inspect", "--format", assertTemplate("{{.Id}}"), assertRemoteImage(tag));

export const remoteContainerExistsCommand = (name: string) => remoteCommand("docker", "ps", "--all", "--filter", `name=^/${assertRemoteName(name)}$`, "--format", assertTemplate("{{.Names}}"));

export const remoteStartCommand = (name: string) => remoteCommand("docker", "start", assertRemoteName(name));

// A graceful stop is given a short, fixed grace period and the operation is bounded by an explicit,
// server-side timeout in the caller. The stop grace plus daemon overhead can exceed the default SSH
// command timeout, so the two values are set together rather than left to collide.
export const remoteStopGraceSeconds = 5;
export const remoteStopCommand = (name: string) => remoteCommand("docker", "stop", "--time", String(remoteStopGraceSeconds), assertRemoteName(name));
export const remoteRemoveCommand = (name: string) => remoteCommand("docker", "rm", "--force", assertRemoteName(name));
export const remoteRestartCommand = (name: string) => remoteCommand("docker", "restart", "--time", String(remoteStopGraceSeconds), assertRemoteName(name));
export const remoteEnvFileExistsCommand = (path: string) => remoteCommand("test", "-f", assertRemotePath(path));

// Container runtime projection, mirroring the local runtime fields but with a comma separator: a pipe
// would be interpreted by the remote shell. Only safe, allowlisted fields are requested.
//
// Published ports are deliberately *not* taken from this command. Flattening a port map with a Go
// template requires `{{range $p, $conf := ...}}`, and `$p` would be expanded to nothing by the remote
// login shell before Docker ever saw it. `docker port` reports the same information with no template
// and no dollar sign.
const remoteRuntimeFields = ["{{.State.Status}}", "{{.State.Running}}", "{{.State.Health.Status}}", "{{.RestartCount}}", "{{.State.StartedAt}}", "{{.Config.Image}}", "{{.HostConfig.RestartPolicy.Name}}"] as const;

export const remoteContainerRuntimeCommand = (name: string) => remoteCommand("docker", "inspect", "--format", assertTemplate(remoteRuntimeFields.join(",")), assertRemoteName(name));

export const remoteContainerStatsCommand = (name: string) => remoteCommand("docker", "stats", "--no-stream", "--format", assertTemplate("{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}"), assertRemoteName(name));

/** Published port bindings, one "containerPort -> host:port" pair per line. */
export const remoteContainerPortsCommand = (name: string) => remoteCommand("docker", "port", assertRemoteName(name));

export const remoteContainerDiagnosticsCommand = (name: string) => remoteCommand("docker", "inspect", "--format", assertTemplate("{{.State.Status}}"), assertRemoteName(name));

export const remoteContainerLogsCommand = (name: string) => remoteCommand("docker", "logs", "--tail", "80", assertRemoteName(name));

/**
 * Writes stdin to a 0600 file. `umask 077` before the redirect means the file is never group- or
 * world-readable, not even in the window before the explicit chmod. This is the only remote command
 * in the codebase that contains a shell operator; it is a literal in this template, and only the
 * validated path is substituted.
 */
export function remoteWriteEnvFileCommand(path: string) {
  const target = assertRemotePath(path);
  return "umask 077 && cat > " + target + " && chmod 600 " + target;
}

/** Best-effort removal of that file. Plain argv, no operator. */
export const remoteRemoveEnvFileCommand = (path: string) => remoteCommand("rm", "-f", assertRemotePath(path));

/** The fixed remote command the image transfer streams into. */
export const REMOTE_IMAGE_LOAD_COMMAND = remoteCommand("docker", "load");
