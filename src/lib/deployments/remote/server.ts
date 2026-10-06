import { prisma } from "@/lib/db";
import { resolvePrivateKey } from "@/lib/servers/service.ts";
import { fingerprintOfLine, openSshTransport, type SshTransport } from "@/lib/servers/ssh.ts";
import { remoteCurlCapabilityCommand } from "./args.ts";
import { RemoteCommandError, RemoteDeploymentError } from "./errors.ts";

export type DeploymentTargetName = "local" | "remote";
export const deploymentTargets: readonly DeploymentTargetName[] = ["local", "remote"];

export function isDeploymentTarget(value: unknown): value is DeploymentTargetName {
  return value === "local" || value === "remote";
}

/**
 * A remote deployment may only ever target a Server record the authenticated user owns. The hostname
 * is read from that record at connect time; nothing in the deployment request can supply one.
 */
export type RemoteServerRef = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  hostKeyLine: string | null;
  hostKeyFingerprint: string | null;
  hostKeyTrustedAt: Date | null;
  status: string;
  dockerAvailable: boolean;
  dockerVersion: string | null;
  architecture: string | null;
  encryptedCredential: string | null;
};

const serverSelect = {
  id: true, name: true, hostname: true, port: true, username: true,
  hostKeyLine: true, hostKeyFingerprint: true, hostKeyTrustedAt: true,
  status: true, dockerAvailable: true, dockerVersion: true, architecture: true,
  encryptedCredential: true,
} as const;

/**
 * Resolves the Server a deployment must use, and fails closed on every precondition. The order is
 * deliberate: ownership, then trust, then reachability, then Docker, then capability. Nothing is
 * built or transferred until all of them pass.
 */
export async function requireDeployableServer(userId: string, serverId: string): Promise<RemoteServerRef> {
  if (!serverId || typeof serverId !== "string") throw new RemoteDeploymentError("server_not_found", "A deployment target server is required.", 400);

  // Ownership is part of the lookup, so another user's server is indistinguishable from a missing one.
  const server = await prisma.server.findFirst({ where: { id: serverId, userId }, select: serverSelect });
  if (!server) throw new RemoteDeploymentError("server_not_found", "The selected deployment server was not found.", 404);

  if (!server.encryptedCredential) throw new RemoteDeploymentError("ssh_connection_failed", "The selected server has no SSH credential configured.", 409);
  if (!server.hostKeyTrustedAt || !server.hostKeyFingerprint) throw new RemoteDeploymentError("host_key_untrusted", "Trust this server's host key before deploying to it.", 428);
  if (!server.hostKeyLine) throw new RemoteDeploymentError("host_key_untrusted", "Trust this server's host key before deploying to it.", 428);

  // The stored fingerprint must still describe the stored key line. If the two pieces of trust state
  // ever diverged, the pinned line is no longer what was trusted, so the connection is refused.
  if (await fingerprintOfLine(server.hostKeyLine) !== server.hostKeyFingerprint) {
    throw new RemoteDeploymentError("host_key_mismatch", "The stored host key no longer matches the trusted fingerprint.", 409);
  }

  if (server.status !== "online") throw new RemoteDeploymentError("server_offline", `${server.name} is not online. Refresh it before deploying.`, 409);
  if (!server.dockerAvailable) throw new RemoteDeploymentError("docker_unavailable", `${server.name} does not have a usable Docker daemon.`, 409);

  return server as RemoteServerRef;
}

export type RemoteDeploymentContext = {
  server: RemoteServerRef;
  userId: string;
  transport: SshTransport;
  /** Local host architecture, so a mismatch is reported rather than silently producing a bad image. */
  localArchitecture: string;
};

/**
 * Opens a pinned SSH connection to a validated server and confirms the remote host can actually
 * perform the two capabilities a deployment needs: a Docker daemon and curl for health verification.
 * A capability failure closes the session before any caller can act on it.
 */
export async function openRemoteDeployment(userId: string, serverId: string): Promise<RemoteDeploymentContext> {
  const server = await requireDeployableServer(userId, serverId);
  const transport = await openSshTransport({
    hostname: server.hostname,
    port: server.port,
    username: server.username,
    privateKey: resolvePrivateKey(server as never),
    hostKeyLine: server.hostKeyLine as string,
  });
  try {
    await transport.run(remoteCurlCapabilityCommand);
    await transport.run("docker version --format {{.Server.Version}}").catch(() => { throw new RemoteDeploymentError("docker_unavailable", `${server.name} did not answer a Docker version check.`, 409); });
  } catch (error) {
    await transport.close();
    throw error;
  }
  return { server, userId, transport, localArchitecture: process.arch };
}

/** Runs a remote command and returns trimmed stdout, or throws a typed remote error. */
export async function remoteRun(transport: SshTransport, command: string, options?: { timeoutMs?: number; maxBytes?: number }) {
  const result = await transport.run(command, options);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
}

export { RemoteCommandError, RemoteDeploymentError };
