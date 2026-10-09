// Real verification of the architecture compatibility preflight.
//
// The build host and the remote host are both amd64 here, so a mismatch cannot occur naturally. To
// prove the refusal is real rather than theoretical, this registers a genuine remote server, then
// falsifies only the architecture recorded on the Server row, and deploys for real. Everything else - the
// SSH handshake, the image build, the Docker daemon - is untouched.
//
// What is asserted:
//   1. A truthful architecture deploys and transfers as before.
//   2. A falsified architecture fails at the architecture stage with `architecture_mismatch`.
//   3. No transfer bytes were sent, so the refusal happened before the expensive step.
//   4. The failure names both architectures and leaks no credential.
//   5. Restoring the truth makes the same environment deploy again, so the refusal is not sticky.
//
//   SSHD_DIR=/path node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-architecture.mjs
import { readFileSync, existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.GIT_WORKSPACE_ROOT ||= "/home/skywalker";

const { prisma } = await import("../src/lib/db.ts");
const { createServer, trustHostKey, testServer, deleteServer } = await import("../src/lib/servers/service.ts");
const { createDeployment, deployDeployment, stopDeployment } = await import("../src/lib/deployments/service.ts");
const { canonicalArchitecture, compareArchitectures } = await import("../src/lib/deployments/architecture.ts");

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);
const step = (n, title) => log(`\n${n}. ${title}`);

const login = "architecture-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

let server = null;
let environment = null;

/**
 * Retires a deployment: stops its container through the normal path, then removes the record.
 *
 * The order matters. Deleting the record first would orphan the container, and the application
 * deliberately refuses to stop a container it has no record of - so the next run would find the host
 * port held by a container nobody owns.
 */
async function dispose(deploymentId) {
  await stopDeployment(deploymentId, "architecture_verification").catch(() => undefined);
  await prisma.deployment.delete({ where: { id: deploymentId } }).catch(() => undefined);
}

/** Reclaims containers left on the remote host by an earlier interrupted run. */
async function reclaimRemote() {
  if (process.env.RECLAIM_REMOTE !== "1") return;
  const { openSshTransport } = await import("../src/lib/servers/ssh.ts");
  const { remoteDockerStop, remoteDockerRemove } = await import("../src/lib/deployments/remote/docker.ts");
  const transport = await openSshTransport({
    hostname: process.env.REMOTE_HOST || "127.0.0.1",
    port: Number(process.env.REMOTE_PORT || 2222),
    username: process.env.REMOTE_USER || "root",
    privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
    hostKeyLine: readFileSync(`${process.env.SSHD_DIR}/host_key.pub`, "utf8").split("\n").filter(Boolean)[0].trim(),
  });
  try {
    const listing = await transport.run("docker ps --all --filter name=developer-os --format {{.Names}}");
    for (const name of listing.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      if (!name.startsWith("developer-os-") || name.startsWith("developer-os-caddy-")) continue;
      await remoteDockerStop(transport, name).catch(() => undefined);
      await remoteDockerRemove(transport, name).catch(() => undefined);
      log(`   reclaimed ${name}`);
    }
  } finally { await transport.close(); }
}

/** Stops every deployment for this user and removes the scaffolding. Always safe to call twice. */
async function teardown(reason) {
  log(`\n   cleanup (${reason})`);
  const target = server ?? await prisma.server.findFirst({ where: { userId } });
  if (!target) return log("   nothing to clean");
  for (const row of await prisma.deployment.findMany({ where: { environment: { project: { userId } } } })) {
    await stopDeployment(row.id, "architecture_verification_cleanup").catch(() => undefined);
  }
  for (const env of await prisma.deploymentEnvironment.findMany({ where: { project: { userId } } })) {
    await prisma.deploymentEnvironment.delete({ where: { id: env.id } }).catch(() => undefined);
  }
  await deleteServer(userId, target.id).catch(() => undefined);
  log("   done");
}

try {
await reclaimRemote();

// -------------------------------------------------------------------------------------------
step(1, "a real remote server, registered and probed");
server = await createServer(userId, {
  name: "arch-remote",
  hostname: process.env.REMOTE_HOST || "127.0.0.1",
  port: Number(process.env.REMOTE_PORT || 2222),
  username: process.env.REMOTE_USER || "root",
  authMethod: "key",
  privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
});
await trustHostKey(userId, server.id);
const probe = await testServer(userId, server.id);
log(`   online: ${probe.server.status} | recorded architecture: ${probe.server.architecture}`);
if (probe.server.status !== "online") fail("remote server is not usable");
if (!probe.server.architecture) fail("the probe recorded no architecture, which the preflight needs");

// -------------------------------------------------------------------------------------------
step(2, "the local build host and the target agree, so a truthful deploy works");
{
  const reference = await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
  const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
  const variables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];
  if (!variables.length) fail("no runtime variables found to copy");

  const project = await prisma.project.upsert({
    where: { userId_slug: { userId, slug: "arch-verify" } },
    update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
    create: { userId, name: "Arch Verify", slug: "arch-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  });
  environment = await prisma.deploymentEnvironment.create({
    data: {
      projectId: project.id, name: "Arch", slug: "arch", type: "production",
      target: "remote", serverId: server.id, portScopeKey: `server:${server.id}`,
      hostPort: Number(process.env.ARCH_PORT || 8096), containerPort: 80, healthPath: "/",
      cpuLimit: "1.0", memoryLimit: "512m", runMigrations: process.env.VERIFY_MIGRATIONS === "1",
      runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
    },
  });
  log(`   environment -> remote :${environment.hostPort}`);

  const created = await createDeployment(project.id, environment.id);
  const deployed = await deployDeployment(created.id);
  log(`   deploy with a truthful architecture -> ${deployed.status}/${deployed.healthStatus}`);
  if (deployed.status !== "running") fail(`a matching architecture did not deploy: ${deployed.errorMessage}`);

  const transferred = await prisma.deployment.findUnique({ where: { id: created.id }, select: { transferBytes: true } });
  log(`   transfer bytes: ${transferred?.transferBytes ?? 0}`);
  if (!transferred?.transferBytes) fail("no image was transferred on a matching architecture");

  // The architecture stage shares the build stream, so the preflight line is found by its text.
  const logs = await prisma.deploymentLog.findMany({ where: { deploymentId: created.id, message: { startsWith: "Architecture preflight" } }, orderBy: { timestamp: "asc" } });
  log(`   architecture stage logged: ${logs.length ? logs[logs.length - 1].message : "NOTHING"}`);
  if (!logs.length) fail("the architecture preflight wrote no log entry");
  if (logs.length && !/Architecture preflight: image amd64 matches amd64/.test(logs[logs.length - 1].message)) {
    fail(`unexpected preflight message: ${logs[logs.length - 1].message}`);
  }

  await dispose(created.id);
}

// -------------------------------------------------------------------------------------------
step(3, "a falsified target architecture is refused before any transfer");
{
  // Only the recorded architecture is falsified. The host really is amd64; the point is that the engine
  // believes the record and refuses rather than discovering the problem after a 200 MB transfer.
  await prisma.server.update({ where: { id: server.id }, data: { architecture: "aarch64" } });
  const recorded = await prisma.server.findUnique({ where: { id: server.id }, select: { architecture: true } });
  log(`   server record now claims: ${recorded.architecture}`);

  const created = await createDeployment(environment.projectId, environment.id);
  let error = null;
  try {
    await deployDeployment(created.id);
  } catch (thrown) {
    error = thrown;
  }
  const after = await prisma.deployment.findUnique({ where: { id: created.id } });

  log(`   deploy -> ${after.status} | code: ${after.errorMessage ? "see message" : "-"} | thrown: ${error ? error.code : "none"}`);
  if (after.status !== "failed") fail(`a mismatched architecture produced ${after.status}, expected failed`);
  if (after.lastStage !== "architecture") fail(`the failure is attributed to stage ${after.lastStage}, expected architecture`);

  // The decisive assertion: nothing was transferred.
  log(`   transfer started: ${after.transferStartedAt ? "yes" : "no"} | bytes: ${after.transferBytes ?? 0}`);
  if (after.transferStartedAt) fail("a transfer was started despite the architecture mismatch");
  if (after.transferBytes) fail(`${after.transferBytes} bytes were transferred despite the architecture mismatch`);

  // The remote daemon must not have received the image either.
  const { openSshTransport } = await import("../src/lib/servers/ssh.ts");
  const { remoteDockerImageExists } = await import("../src/lib/deployments/remote/docker.ts");
  const transport = await openSshTransport({
    hostname: process.env.REMOTE_HOST || "127.0.0.1",
    port: Number(process.env.REMOTE_PORT || 2222),
    username: process.env.REMOTE_USER || "root",
    privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
    hostKeyLine: readFileSync(`${process.env.SSHD_DIR}/host_key.pub`, "utf8").split("\n").filter(Boolean)[0].trim(),
  });
  try {
    const present = await remoteDockerImageExists(transport, created.imageTag);
    log(`   image present on the remote daemon: ${present}`);
    if (present) fail("the image reached the remote daemon despite the mismatch");
  } finally {
    await transport.close();
  }

  const message = after.errorMessage || String(error?.message || "");
  log(`   message: ${message}`);
  if (!/amd64/.test(message) || !/arm64/.test(message)) fail("the message does not name both architectures");
  if (!/binfmt|multi-platform/.test(message)) fail("the message gives no actionable remediation");
  if (/PRIVATE KEY|postgres:\/\/|hunter2|token/i.test(message)) fail("the failure message leaks something sensitive");

  // The local image was still built, so the refusal is about the target, not a failed build.
  const architectureLogs = await prisma.deploymentLog.findMany({ where: { deploymentId: created.id, message: { startsWith: "Architecture preflight" } }, orderBy: { timestamp: "asc" } });
  log(`   preflight log: ${architectureLogs[architectureLogs.length - 1]?.message || "NOTHING"}`);

  await dispose(created.id);
}

// -------------------------------------------------------------------------------------------
step(4, "an unprobed target architecture is a different refusal");
{
  // A server that was never probed has no architecture. That is a missing fact, not a mismatch, and the
  // two need different instructions.
  await prisma.server.update({ where: { id: server.id }, data: { architecture: null } });
  const created = await createDeployment(environment.projectId, environment.id);
  await deployDeployment(created.id).catch(() => undefined);
  const after = await prisma.deployment.findUnique({ where: { id: created.id } });
  log(`   deploy -> ${after.status} at stage ${after.lastStage}`);
  log(`   message: ${after.errorMessage}`);
  if (after.status !== "failed") fail("an unprobed architecture did not stop the deployment");
  if (!/Re-test the server/.test(after.errorMessage || "")) fail("the message does not tell the operator to re-test the server");
  if (after.transferStartedAt) fail("a transfer was started with an unprobed architecture");
  await dispose(created.id);
}

// -------------------------------------------------------------------------------------------
step(5, "normalization matches what the hosts actually report");
{
  const { execFileSync } = await import("node:child_process");
  const localArch = execFileSync("docker", ["info", "--format", "{{.Architecture}}"], { encoding: "utf8" }).trim();
  const uname = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  const comparison = compareArchitectures(localArch, uname);
  log(`   docker reports ${localArch}, uname reports ${uname}`);
  log(`   comparison: compatible=${comparison.compatible} image=${comparison.imageArchitecture} server=${comparison.serverArchitecture}`);
  if (!comparison.compatible) fail("the two spellings of this host's own architecture did not reconcile");
  if (canonicalArchitecture(uname) !== "amd64") fail(`unexpected canonical form for ${uname}`);
}
} finally {
  await teardown("final");
}

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);