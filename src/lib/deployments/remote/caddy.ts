// Fixed remote Caddy operations.
//
// The reverse proxy is one long-lived container per registered server. Its configuration is written to a
// host directory mounted into the container, and Caddy is asked to reload in place, so a domain change
// never restarts the proxy and never drops traffic for the other domains on that server.
//
// Every command below is a fixed argv sequence built from validated values, exactly as in the deployment
// path. There is no generic remote runner, and the rendered Caddyfile travels over stdin rather than
// through a command line.

import { RemoteCommandError, assertRemoteImage, assertRemoteName, assertRemotePath, remoteCommand } from "./args.ts";

// The image is a fixed constant. A caller selects a version at most; nothing else about the container is
// configurable, and there is no way to supply a command or a flag.
export const CADDY_IMAGE = "caddy:2-alpine";
export const CADDY_CONTAINER_PREFIX = "developer-os-caddy";

// Host directory mounted at /data, which is where Caddy keeps its configuration, its state, and the
// root of the certificate authority it creates for internal_ca.
export const caddyDataDirectory = "/var/lib/developer-os/caddy";

/** Where the configuration lives inside the container. */
export const caddyConfigPath = "/data/Caddyfile";

/** Where the same file lives on the host, which is what a write over SSH has to target. */
export const caddyHostConfigPath = caddyDataDirectory + "/Caddyfile";

export const caddyRootCertificatePath = "/data/caddy/pki/authorities/local/root.crt";

export const CADDY_HTTP_PORT = 80;
export const CADDY_HTTPS_PORT = 443;

// The proxy needs both ports published. Neither is ever taken from a request.
const portsArgument = `--publish ${CADDY_HTTP_PORT}:80 --publish ${CADDY_HTTPS_PORT}:443`;

/** The container name for a server, derived from the server id and therefore not caller-supplied. */
export function caddyContainerName(serverId: string) {
  const suffix = String(serverId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  if (!suffix) throw new RemoteCommandError("A server is required.");
  return assertRemoteName(`${CADDY_CONTAINER_PREFIX}-${suffix}`);
}

export function caddyRunArguments(serverId: string, image = CADDY_IMAGE) {
  const name = caddyContainerName(serverId);
  return remoteCommand(
    "docker", "run", "--detach",
    "--name", name,
    portsArgument,
    "--restart", "unless-stopped",
    "--memory", "512m",
    "--pids-limit", "256",
    // The deployment containers reach the proxy through loopback, so the proxy needs no network of its own
    // beyond the default bridge, and it is never given the Docker socket.
    "--mount", `type=bind,src=${caddyDataDirectory},dst=/data`,
    assertRemoteImage(image),
  );
}

export const caddyExistsCommand = (name: string) => remoteCommand("docker", "ps", "--all", "--filter", `name=^/${assertRemoteName(name)}$`, "--format", "{{.Names}}");
export const caddyStartCommand = (name: string) => remoteCommand("docker", "start", assertRemoteName(name));
export const caddyRemoveCommand = (name: string) => remoteCommand("docker", "rm", "--force", assertRemoteName(name));
export const caddyImageInspectCommand = (image: string) => remoteCommand("docker", "image", "inspect", "--format", "{{.Id}}", assertRemoteImage(image));

// The directory must already exist on the host before a container can bind it, so it is created first
// and separately rather than as a side effect of writing the configuration.
export const caddyEnsureDirectoryCommand = () =>
  "umask 077 && mkdir -p " + assertRemotePath(caddyDataDirectory);

// The global options block plus every site block arrives on stdin. The directory is created under
// `umask 077` so the configuration is never readable by another user on the host, including in the window
// before the explicit chmod.
export function caddyWriteConfigCommand(target = caddyHostConfigPath) {
  return "umask 077 && cat > " + assertRemotePath(target) + " && chmod 600 " + assertRemotePath(target);
}

// Reload rather than restart, so in-flight requests are not dropped.
export const caddyReloadCommand = (name: string) => remoteCommand("docker", "exec", assertRemoteName(name), "caddy", "reload", "--config", caddyConfigPath);

export const caddyValidateCommand = (name: string) => remoteCommand("docker", "exec", assertRemoteName(name), "caddy", "validate", "--config", caddyConfigPath);

// Reads back the certificate Caddy's internal authority created, so a client can be told exactly what to
// trust. Empty output simply means the authority has not been created yet.
export const caddyReadRootCertificateCommand = (name: string) => remoteCommand("docker", "exec", assertRemoteName(name), "cat", caddyRootCertificatePath);

// Reads the configuration Caddy is actually running, so drift between the desired configuration and the
// applied one can be detected rather than assumed. Empty output simply means no configuration is loaded.
export const caddyReadConfigCommand = (name: string) => remoteCommand("docker", "exec", assertRemoteName(name), "cat", caddyConfigPath);

export const caddyRemoveDataCommand = remoteCommand("rm", "-rf", caddyDataDirectory);

// Health verification goes through the proxy from the host itself, so the request path that matters is
// exercised exactly as an external client would exercise it, including TLS and the Host header.
export function caddyHttpProbeCommand(hostname: string, scheme = "http") {
  const host = assertRemoteName(hostname);
  if (scheme !== "http" && scheme !== "https") throw new RemoteCommandError("Scheme is not allowed.");
  return remoteCommand("curl", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "10", "--resolve", `${host}:${scheme === "https" ? CADDY_HTTPS_PORT : CADDY_HTTP_PORT}:127.0.0.1`, "--header", `Host: ${host}`, `${scheme}://${host}/`);
}

export function caddyHttpsProbeCommand(hostname: string) {
  return caddyHttpProbeCommand(hostname, "https");
}

// Used to report why a route is not answering, without leaking a response body from a public endpoint.
export function caddyTlsProbeCommand(hostname: string) {
  const host = assertRemoteName(hostname);
  return remoteCommand("curl", "--silent", "--show-error", "--output", "/dev/null", "--insecure", "--write-out", "%{http_code}", "--max-time", "10", "--resolve", `${host}:${CADDY_HTTPS_PORT}:127.0.0.1`, "--header", `Host: ${host}`, `https://${host}/`);
}