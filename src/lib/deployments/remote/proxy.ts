// Drives the reverse proxy on a registered server over the existing pinned SSH transport.
//
// This reuses Phase 10's transport and Phase 11's fixed-command discipline. It adds no new capability: the
// only remote operations are the fixed functions in remote/caddy.ts, and the proxy configuration reaches
// the host as a byte stream over stdin rather than as a command line.

import { Readable } from "node:stream";
import type { SshTransport } from "@/lib/servers/ssh.ts";
import { RemoteDeploymentError } from "./errors.ts";
import { summarizeRemoteFailure } from "./diagnostics.ts";
import {
  CADDY_IMAGE,
  caddyContainerName,
  caddyEnsureDirectoryCommand,
  caddyExistsCommand,
  caddyHttpProbeCommand,
  caddyReadRootCertificateCommand,
  caddyReloadCommand,
  caddyRemoveCommand,
  caddyRemoveDataCommand,
  caddyRunArguments,
  caddyStartCommand,
  caddyTlsProbeCommand,
  caddyValidateCommand,
  caddyWriteConfigCommand,
} from "./caddy.ts";

// A proxy container is long-lived, so its operations get a longer bound than a probe but are still fixed.
const proxyCommandTimeoutMs = 60000;
const proxyTransferTimeoutMs = 120000;

async function run(transport: SshTransport, command: string, options?: { timeoutMs?: number; failureCode?: string; failureMessage?: string }) {
  try {
    return await transport.run(command, { timeoutMs: options?.timeoutMs ?? proxyCommandTimeoutMs, maxBytes: 256 * 1024 });
  } catch (error) {
    const failure = error as { code?: string; message?: string; status?: number };
    const detail = summarizeRemoteFailure(failure.message ?? "");
    const summary = options?.failureMessage ?? "The reverse proxy operation failed.";
    throw new RemoteDeploymentError(options?.failureCode ?? failure.code ?? "ssh_connection_failed", detail ? `${summary} ${detail}` : summary, failure.status ?? 502);
  }
}

async function runWithInput(transport: SshTransport, command: string, input: string) {
  try {
    return await transport.pipe(command, Readable.from([Buffer.from(input, "utf8")]), { timeoutMs: proxyTransferTimeoutMs, maxBytes: 64 * 1024 });
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    const detail = summarizeRemoteFailure(failure.message ?? "");
    throw new RemoteDeploymentError("proxy_config_write_failed", detail ? `The proxy configuration could not be written. ${detail}` : "The proxy configuration could not be written.", 502);
  }
}

const lastLine = (stdout: string) => stdout.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";

export async function remoteCaddyExists(transport: SshTransport, serverId: string) {
  const name = caddyContainerName(serverId);
  const result = await run(transport, caddyExistsCommand(name));
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).includes(name);
}

/**
 * Ensures the server has a running proxy container, starting an existing one before creating a new one.
 * Never touches a container it does not own: the name is derived from the server id and must match.
 */
export async function remoteEnsureCaddy(transport: SshTransport, serverId: string, onImagePull?: (message: string) => void) {
  const name = caddyContainerName(serverId);

  // The bind source must exist before a container can mount it, so the directory is created first.
  await run(transport, caddyEnsureDirectoryCommand(), { failureCode: "proxy_directory_failed", failureMessage: "The proxy data directory could not be created." });

  // The image is pulled explicitly so a first run reports progress rather than appearing to hang.
  await run(transport, "docker pull " + CADDY_IMAGE, { timeoutMs: 300000, failureCode: "proxy_image_unavailable", failureMessage: "The reverse proxy image could not be pulled." }).catch((error) => {
    // A pull failure is not fatal on its own: the image may already be present. Creating the container
    // below is the real test.
    onImagePull?.(summarizeRemoteFailure(error instanceof Error ? error.message : ""));
    return undefined;
  });

  if (await remoteCaddyExists(transport, serverId)) {
    await run(transport, caddyStartCommand(name), { failureCode: "proxy_start_failed", failureMessage: "The existing reverse proxy could not be started." }).catch(() => undefined);
    return { created: false, name };
  }

  await run(transport, caddyRunArguments(serverId), { failureCode: "proxy_start_failed", failureMessage: "The reverse proxy container could not be created." });
  return { created: true, name };
}

/** Writes the rendered configuration, then asks Caddy to validate it before adopting it. */
export async function remoteWriteAndReloadCaddy(transport: SshTransport, serverId: string, contents: string) {
  const name = caddyContainerName(serverId);
  const written = await runWithInput(transport, caddyWriteConfigCommand(), contents);
  if (written.code !== 0) {
    throw new RemoteDeploymentError("proxy_config_write_failed", summarizeRemoteFailure(written.stderr) || "The proxy configuration could not be written.", 502);
  }
  // Validating before reloading means an invalid file is reported rather than left to a restart to find.
  await run(transport, caddyValidateCommand(name), { failureCode: "proxy_config_invalid", failureMessage: "The generated proxy configuration was rejected by Caddy." });
  const reloaded = await run(transport, caddyReloadCommand(name), { failureCode: "proxy_reload_failed", failureMessage: "The reverse proxy could not reload its configuration." });
  return summarizeRemoteFailure(reloaded.stderr);
}

/** The certificate Caddy's internal authority created, for a client that wants to trust it. */
export async function remoteReadCaddyRootCertificate(transport: SshTransport, serverId: string) {
  const name = caddyContainerName(serverId);
  const result = await run(transport, caddyReadRootCertificateCommand(name), { timeoutMs: 15000 }).catch(() => ({ stdout: "", stderr: "" }));
  return result.stdout.trim();
}

export type ProxyProbe = { ok: boolean; status: number | null; scheme: "http" | "https"; message: string };

/**
 * Verifies a route from the proxy host itself, so the request a client would make is exercised through
 * the real listener, the real TLS handshake, and the real Host header.
 */
export async function remoteProbeRoute(transport: SshTransport, hostname: string, tls: boolean): Promise<ProxyProbe> {
  const command = tls ? caddyTlsProbeCommand(hostname) : caddyHttpProbeCommand(hostname, "http");
  try {
    const result = await run(transport, command, { timeoutMs: 20000, failureCode: "proxy_probe_failed", failureMessage: "The reverse proxy could not be probed." });
    const status = Number.parseInt(lastLine(result.stdout), 10);
    if (Number.isInteger(status) && status > 0) {
      return { ok: status >= 200 && status < 500, status, scheme: tls ? "https" : "http", message: `HTTP ${status}` };
    }
    return { ok: false, status: null, scheme: tls ? "https" : "http", message: "The reverse proxy returned no status." };
  } catch (error) {
    const failure = error as { code?: string; message?: string };
    return { ok: false, status: null, scheme: tls ? "https" : "http", message: summarizeRemoteFailure(failure.message ?? "") || failure.code || "The reverse proxy did not answer." };
  }
}

/** Removes the proxy and its data. Used when a server stops being used for exposure. */
export async function remoteRemoveCaddy(transport: SshTransport, serverId: string, removeData: boolean) {
  const name = caddyContainerName(serverId);
  await run(transport, caddyRemoveCommand(name)).catch(() => undefined);
  if (removeData) await run(transport, caddyRemoveDataCommand).catch(() => undefined);
}