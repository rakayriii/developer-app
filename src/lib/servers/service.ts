import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/deployments/crypto";
import { probeNames, SshError, scanHostKey, scanHostKeyWithCredential, connect, fingerprintOfLine, safeDiagnostic, type ProbeName, type SshSession } from "./ssh";
import { assembleProbeResult } from "./probe";
import { credentialFingerprint, validateServerInput, ServerConflictError, ServerInUseError, ServerNotFoundError, ServerValidationError } from "./validation";
import { toPublicServer as publicServer, type ServerRecord, type PublicServer } from "./serialize";
import { isPrismaUnavailable } from "@/lib/api/contract";


export async function listServers(userId: string) {
  const rows = await prisma.server.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }) as ServerRecord[];
  return rows.map(publicServer);
}

export async function ownedServer(userId: string, id: string) {
  return prisma.server.findFirst({ where: { id, userId } }) as Promise<ServerRecord | null>;
}

export async function requireOwnedServer(userId: string, id: string) {
  const server = await ownedServer(userId, id);
  if (!server) throw new ServerNotFoundError();
  return server;
}

export async function createServer(userId: string, body: Record<string, unknown>) {
  const input = validateServerInput(body);
  if (!input.privateKey) throw new ServerValidationError("A private key is required.");
  const existing = await prisma.server.findFirst({ where: { userId, hostname: input.hostname, port: input.port } });
  if (existing) throw new ServerConflictError("A server with this hostname and port is already registered.");
  const created = await prisma.server.create({ data: { userId, name: input.name, hostname: input.hostname, port: input.port, username: input.username, authMethod: input.authMethod, encryptedCredential: encryptSecret(input.privateKey), credentialFingerprint: credentialFingerprint(input.privateKey), credentialConfigured: true, status: "unknown" } }) as ServerRecord;
  return publicServer(created);
}

const editableFields = ["name", "hostname", "port", "username"] as const;

export async function updateServer(userId: string, id: string, body: Record<string, unknown>) {
  const server = await requireOwnedServer(userId, id);
  const merged: Record<string, unknown> = { name: server.name, hostname: server.hostname, port: server.port, username: server.username, authMethod: server.authMethod };
  for (const field of editableFields) if (body[field] !== undefined) merged[field] = body[field];
  // Validating the merge keeps hostname, port, and username rules identical on create and update.
  const input = validateServerInput(merged);
  const data: Record<string, unknown> = { name: input.name, hostname: input.hostname, port: input.port, username: input.username };
  if (typeof body.privateKey === "string" && body.privateKey.trim()) {
    const key = validateServerInput({ ...merged, privateKey: body.privateKey }).privateKey;
    if (!key) throw new ServerValidationError("Private key is invalid.");
    data.encryptedCredential = encryptSecret(key);
    data.credentialFingerprint = credentialFingerprint(key);
    data.credentialConfigured = true;
  }
  if (input.hostname !== server.hostname || input.port !== server.port) {
    // Checked before the write so a duplicate endpoint is a clean 409 rather than a constraint error.
    const clash = await prisma.server.findFirst({ where: { userId, hostname: input.hostname, port: input.port, id: { not: id } } });
    if (clash) throw new ServerConflictError("Another server already uses this hostname and port.");
    // A new endpoint must be re-trusted from scratch rather than inheriting the old host key.
    data.hostKeyFingerprint = null;
    data.hostKeyLine = null;
    data.hostKeyTrustedAt = null;
  }
  return publicServer(await prisma.server.update({ where: { id }, data }) as ServerRecord);
}

// Removes the server record and its encrypted credential. Nothing remote is touched.
export async function deleteServer(userId: string, id: string) {
  await requireOwnedServer(userId, id);
  // A server that still hosts an environment or a deployment cannot be removed. That is deliberate: the
  // foreign keys are RESTRICT so a running remote deployment can never lose the record of where its
  // container lives. Say so plainly instead of surfacing a foreign-key constraint failure.
  const [environments, deployments] = await Promise.all([
    prisma.deploymentEnvironment.count({ where: { serverId: id } }),
    prisma.deployment.count({ where: { serverId: id } }),
  ]);
  if (environments || deployments) {
    throw new ServerInUseError(
      `This server is still referenced by ${environments} environment(s) and ${deployments} deployment(s). Repoint or delete them before removing the server.`,
    );
  }
  await prisma.server.delete({ where: { id } });
  return { ok: true };
}

async function recordCheck(serverId: string, entry: { status: string; code?: string | null; message?: string | null; hostKeyFingerprint?: string | null; hostKeyTrusted?: boolean; durationMs?: number | null }) {
  await prisma.serverCheck.create({ data: { serverId, status: entry.status as "unknown" | "online" | "offline" | "error", code: entry.code ?? null, message: entry.message ? safeDiagnostic(entry.message).slice(0, 500) : null, hostKeyFingerprint: entry.hostKeyFingerprint ?? null, hostKeyTrusted: entry.hostKeyTrusted ?? false, durationMs: entry.durationMs ?? null } });
}

async function runProbes(session: SshSession) {
  const values: Record<string, string> = {};
  for (const probe of probeNames as ProbeName[]) values[probe] = await session.exec(probe);
  return assembleProbeResult(values as { os: string; arch: string; kernel: string; cpu: string; memory: string; disk: string; docker: string });
}

// Decrypts a stored credential. Exported so a remote deployment reuses the same helper instead of
// re-implementing decryption; the plaintext is only ever passed straight into the SSH transport,
// which writes it to a 0600 file that is removed when the session ends.
export function resolvePrivateKey(server: { encryptedCredential: string | null }) {
  if (!server.encryptedCredential) throw new SshError("authentication_failed", "No SSH credential is configured for this server.", 409);
  const key = decryptSecret(server.encryptedCredential);
  if (!key) throw new SshError("authentication_failed", "The stored SSH credential could not be decrypted.", 409);
  return key;
}

export type TestOutcome = { server: PublicServer; check: { status: string; code: string | null; message: string | null; hostKeyFingerprint: string | null; hostKeyTrusted: boolean; durationMs: number | null } };

// Registers the currently presented host key as trusted. Explicit operator action, never automatic.
export async function trustHostKey(userId: string, id: string) {
  const server = await requireOwnedServer(userId, id);
  // Prefer an authenticated read of the presented key; fall back to keyscan when the credential
  // cannot authenticate, which is also how a bad host key is discovered on an untrusted server.
  const presented = (await scanHostKeyWithCredential(server.hostname, server.port, server.username, resolvePrivateKey(server))) ?? await scanHostKey(server.hostname, server.port);
  if (server.hostKeyFingerprint && server.hostKeyFingerprint !== presented.fingerprint) throw new SshError("host_key_mismatch", "The presented host key differs from the fingerprint already trusted for this server.", 409);
  const updated = await prisma.server.update({ where: { id }, data: { hostKeyFingerprint: presented.fingerprint, hostKeyLine: presented.knownHostsLine, hostKeyTrustedAt: new Date() } }) as ServerRecord;
  return { hostKeyFingerprint: presented.fingerprint, keyType: presented.keyType, line: presented.knownHostsLine, server: publicServer(updated) };
}

export async function testServer(userId: string, id: string): Promise<TestOutcome> {
  const server = await requireOwnedServer(userId, id);
  const startedAt = Date.now();
  const record = async (status: "online" | "offline" | "error" | "unknown", code: string | null, message: string | null) => {
    const durationMs = Date.now() - startedAt;
    await recordCheck(id, { status, code, message, hostKeyFingerprint: server.hostKeyFingerprint, hostKeyTrusted: server.hostKeyTrustedAt !== null, durationMs });
    const updated = await prisma.server.update({ where: { id }, data: { status, statusCode: code, statusMessage: message ? safeDiagnostic(message).slice(0, 300) : null, lastCheckedAt: new Date(), lastError: message ? safeDiagnostic(message).slice(0, 300) : null } }) as ServerRecord;
    return { server: publicServer(updated), check: { status, code, message, hostKeyFingerprint: server.hostKeyFingerprint, hostKeyTrusted: server.hostKeyTrustedAt !== null, durationMs } };
  };

  try {
    if (!server.hostKeyFingerprint) throw new SshError("host_key_untrusted", "Trust this host key before connecting.", 428);
    if (!server.hostKeyLine) throw new SshError("host_key_untrusted", "Trust this host key before connecting.", 428);
    // The stored fingerprint must still describe the stored key line, otherwise the two pieces of
    // trust state have diverged and the connection must not be attempted.
    if (await fingerprintOfLine(server.hostKeyLine) !== server.hostKeyFingerprint) throw new SshError("host_key_mismatch", "The stored host key no longer matches the trusted fingerprint.", 409);
    const privateKey = resolvePrivateKey(server);
    // The trusted key line is pinned directly, so a changed key is refused by ssh itself. No
    // keyscan is performed here: remote sshd penalises unauthenticated probe connections, and
    // verification is already guaranteed by StrictHostKeyChecking against the stored line.
    const session = await connect({ hostname: server.hostname, port: server.port, username: server.username, privateKey, hostKeyLine: server.hostKeyLine });
    try {
      const probes = await runProbes(session);
      const updated = await prisma.server.update({ where: { id }, data: { ...probes, status: "online", statusCode: null, statusMessage: null, lastCheckedAt: new Date(), lastConnectedAt: new Date(), lastError: null } }) as ServerRecord;
      const durationMs = Date.now() - startedAt;
      await recordCheck(id, { status: "online", code: null, message: "Connection verified.", hostKeyFingerprint: server.hostKeyFingerprint, hostKeyTrusted: true, durationMs });
      return { server: publicServer(updated), check: { status: "online", code: null, message: "Connection verified.", hostKeyFingerprint: server.hostKeyFingerprint, hostKeyTrusted: true, durationMs } };
    } finally {
      await session.close();
    }
  } catch (error) {
    const failure = error instanceof SshError ? { code: error.code, message: error.message } : { code: "ssh_connection_failed", message: "The SSH connection failed." };
    return record(failure.code === "host_unreachable" || failure.code === "command_timeout" || failure.code === "ssh_connection_failed" ? "offline" : "error", failure.code, failure.message);
  }
}

export async function refreshServer(userId: string, id: string) {
  return testServer(userId, id);
}

export async function recentChecks(userId: string, id: string, take = 20) {
  await requireOwnedServer(userId, id);
  const rows = await prisma.serverCheck.findMany({ where: { serverId: id }, orderBy: { createdAt: "desc" }, take });
  return rows.map((row) => ({ id: row.id, status: row.status, code: row.code, message: row.message, hostKeyFingerprint: row.hostKeyFingerprint, hostKeyTrusted: row.hostKeyTrusted, durationMs: row.durationMs, createdAt: row.createdAt }));
}

const structuredErrors = [SshError, ServerValidationError, ServerNotFoundError, ServerConflictError, ServerInUseError];

export function serverError(error: unknown) {
  for (const kind of structuredErrors) if (error instanceof kind) return { code: (error as { code: string }).code, message: (error as Error).message, status: (error as { status: number }).status };
  // A database outage is a 503 with a specific code, never an opaque 500 or an empty list.
  if (isPrismaUnavailable(error)) return { code: "database_unavailable", message: "The application database is unavailable. Start PostgreSQL and try again.", status: 503 };
  // A raw Prisma failure must not leak a schema or connection detail to the browser.
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string" && /^P\d{4}$/.test((error as { code: string }).code)) return { code: "server_error", message: "The server operation failed.", status: 500 };
  return { code: "server_error", message: "The server operation failed.", status: 500 };
}
