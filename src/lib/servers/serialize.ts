export type PublicServer = {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: string;
  credentialConfigured: boolean;
  credentialFingerprint: string | null;
  hostKeyFingerprint: string | null;
  hostKeyTrusted: boolean;
  status: string;
  statusCode: string | null;
  statusMessage: string | null;
  osName: string | null;
  osVersion: string | null;
  architecture: string | null;
  kernel: string | null;
  dockerVersion: string | null;
  dockerAvailable: boolean;
  cpuCount: number | null;
  memoryBytes: number | null;
  diskBytes: number | null;
  diskFreeBytes: number | null;
  lastCheckedAt: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt?: string | null;
};

export type ServerRecord = {
  id: string;
  userId: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: string;
  encryptedCredential: string | null;
  credentialFingerprint: string | null;
  hostKeyFingerprint: string | null;
  hostKeyLine: string | null;
  hostKeyTrustedAt: Date | null;
  status: string;
  statusCode: string | null;
  statusMessage: string | null;
  osName: string | null;
  osVersion: string | null;
  architecture: string | null;
  kernel: string | null;
  dockerVersion: string | null;
  dockerAvailable: boolean;
  cpuCount: number | null;
  memoryBytes: bigint | null;
  diskBytes: bigint | null;
  diskFreeBytes: bigint | null;
  lastCheckedAt: Date | null;
  lastConnectedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// The single public projection for a server. Encrypted credential material, ciphertext, and any
// decrypted value are structurally absent from the return type, so they cannot be serialized.
export function toPublicServer(server: ServerRecord): PublicServer {
  return {
    id: server.id,
    name: server.name,
    hostname: server.hostname,
    port: server.port,
    username: server.username,
    authMethod: server.authMethod,
    credentialConfigured: server.encryptedCredential !== null,
    credentialFingerprint: server.credentialFingerprint,
    hostKeyFingerprint: server.hostKeyFingerprint,
    hostKeyTrusted: server.hostKeyTrustedAt !== null,
    status: server.status,
    statusCode: server.statusCode,
    statusMessage: server.statusMessage,
    osName: server.osName,
    osVersion: server.osVersion,
    architecture: server.architecture,
    kernel: server.kernel,
    dockerVersion: server.dockerVersion,
    dockerAvailable: server.dockerAvailable,
    cpuCount: server.cpuCount,
    memoryBytes: server.memoryBytes === null ? null : Number(server.memoryBytes),
    diskBytes: server.diskBytes === null ? null : Number(server.diskBytes),
    diskFreeBytes: server.diskFreeBytes === null ? null : Number(server.diskFreeBytes),
    lastCheckedAt: server.lastCheckedAt ? server.lastCheckedAt.toISOString() : null,
    lastConnectedAt: server.lastConnectedAt ? server.lastConnectedAt.toISOString() : null,
    lastError: server.lastError,
    createdAt: server.createdAt ? server.createdAt.toISOString() : null,
    updatedAt: server.updatedAt ? server.updatedAt.toISOString() : null,
  };
}
