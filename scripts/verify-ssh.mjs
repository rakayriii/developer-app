// Real SSH verification against a throwaway sshd. Registers a server through the real service
// layer, trusts its host key, and runs the connection test, so the probe allowlist, pinned host key,
// bounded timeouts, and error mapping are all exercised for real rather than mocked.
import { readFileSync, existsSync } from "node:fs";

// Reuse the application's real secret so the verification writes ciphertext the running app can read.
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.SESSION_SECRET ||= "verify-ssh-placeholder-secret-not-used-for-production";


const dir = process.env.SSHD_DIR || "/tmp/opencode/sshd";
const username = process.env.SSH_USER || process.env.USER;

const { prisma } = await import("../src/lib/db.ts");
const { createServer, testServer, trustHostKey } = await import("../src/lib/servers/service.ts");

const login = "ssh-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

const privateKey = readFileSync(`${dir}/client_key`, "utf8");

const created = await createServer(userId, {
  name: "throwaway-sshd",
  hostname: "127.0.0.1",
  port: 2222,
  username,
  authMethod: "key",
  privateKey,
});

console.log("registered:", created.name, "| status:", created.status);
console.log("  credential stored:", created.credentialConfigured, "| fingerprint:", created.credentialFingerprint);
console.log("  public projection carries no key material:", !JSON.stringify(created).includes("PRIVATE KEY"));

const trust = await trustHostKey(userId, created.id);
console.log("\nhost key trusted:", trust.hostKeyFingerprint, "| type:", trust.keyType);

const outcome = await testServer(userId, created.id);
const { server, check } = outcome;

console.log("\nconnection test:");
console.log("  status:      ", server.status);
console.log("  code:        ", check.code ?? "(none)");
console.log("  durationMs:  ", check.durationMs);
console.log("  os:          ", [server.osName, server.osVersion, server.architecture].filter(Boolean).join(" "));
console.log("  kernel:      ", server.kernel);
console.log("  docker:      ", server.dockerAvailable, server.dockerVersion ?? "");
console.log("  cpu:         ", server.cpuCount);
console.log("  memoryBytes: ", server.memoryBytes);
console.log("  diskBytes:   ", server.diskBytes, "free:", server.diskFreeBytes);
console.log("  hostKey:     ", server.hostKeyFingerprint, "trusted:", server.hostKeyTrusted);
console.log("  message:     ", server.statusMessage ?? "");

const publicJson = JSON.stringify(server);
const leaked = ["PRIVATE KEY", privateKey.trim().split("\n")[1]].filter((needle) => publicJson.includes(needle));
if (leaked.length) throw new Error("private key material leaked into the public projection");

const ok = server.status === "online" && server.dockerAvailable === true && Number(server.cpuCount) > 0 && Number(server.memoryBytes) > 0;

await prisma.server.delete({ where: { id: created.id } }).catch(() => undefined);
await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
await prisma.$disconnect();

console.log(ok ? "\nRESULT: PASSED" : "\nRESULT: FAILED");
process.exit(ok ? 0 : 1);
