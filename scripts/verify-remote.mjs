// Real end-to-end verification of a REMOTE deployment against a disposable remote host.
//
// The host is a separate container with its own Docker daemon, its own image store, and its own
// filesystem, reached over SSH with a pinned host key. Nothing here is mocked: the image is really
// built locally, really streamed over SSH, really loaded by the remote daemon, and the remote
// container is really started, migrated, and health-checked over the SSH connection.
//
// The remote environment is created on the *same project* as the existing local one and copies its
// real runtime variables, including the encrypted APP_KEY, so the remote container is configured
// exactly like the local one. That is what makes the health check meaningful.
//
// Usage:
//   SSHD_DIR=/path node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-remote.mjs
import { readFileSync, existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.GIT_WORKSPACE_ROOT ||= "/home/skywalker";

const sshDir = process.env.SSHD_DIR;
if (!sshDir) throw new Error("Set SSHD_DIR to the disposable remote host's key directory.");

const { prisma } = await import("../src/lib/db.ts");
const { createServer, trustHostKey, testServer, deleteServer } = await import("../src/lib/servers/service.ts");
const { createDeployment, deployDeployment, restartDeployment, stopDeployment, redeployDeployment, rollbackCandidates, rollbackDeployment, deploymentRuntime } = await import("../src/lib/deployments/service.ts");

const log = (...parts) => console.log(...parts);
const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const step = (number, title) => log(`\n${number}. ${title}`);

// -------------------------------------------------------------------------------------------
// 1. Register and trust the disposable remote server
// -------------------------------------------------------------------------------------------
step(1, "server registration and host-key trust");
const login = "remote-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

// Clean leftovers from an earlier run, in dependency order.
for (const stale of await prisma.deploymentEnvironment.findMany({ where: { project: { userId } }, select: { id: true } })) {
  await prisma.deployment.deleteMany({ where: { environmentId: stale.id } });
  await prisma.deploymentEnvironment.delete({ where: { id: stale.id } }).catch(() => undefined);
}
await prisma.deployment.deleteMany({ where: { project: { userId } } });
await prisma.server.deleteMany({ where: { userId } });

const server = await createServer(userId, {
  name: "disposable-remote",
  hostname: process.env.REMOTE_HOST || "127.0.0.1",
  port: Number(process.env.REMOTE_PORT || 2222),
  username: process.env.REMOTE_USER || "root",
  authMethod: "key",
  privateKey: readFileSync(`${sshDir}/client_key`, "utf8"),
});
log("   registered:", server.name, "| credential stored:", server.credentialConfigured, "| no key in response:", !JSON.stringify(server).includes("PRIVATE KEY"));
if (JSON.stringify(server).includes("PRIVATE KEY")) fail("the private key reached the public server projection");

await trustHostKey(userId, server.id);
log("   host key trusted");

const probe = await testServer(userId, server.id);
log("   connection test:", probe.server.status, "| docker", probe.server.dockerVersion, "| arch", probe.server.architecture, "|", probe.check.durationMs + "ms");
if (probe.server.status !== "online") fail(`server is ${probe.server.status}`);
if (!probe.server.dockerAvailable) fail("remote Docker is unavailable");

// -------------------------------------------------------------------------------------------
// 2. A remote environment beside the existing local one
// -------------------------------------------------------------------------------------------
step(2, "remote environment with the real runtime variables");
// Prefer the real, already-deployed project so the remote deployment is genuinely equivalent to the
// local one: same repository, same runtime variables, same encrypted APP_KEY.
const projectName = process.env.VERIFY_PROJECT;
// Find the real, already-deployed project so the remote target is genuinely equivalent to the local
// one: same repository, same runtime variables, same encrypted APP_KEY. A separate verification project
// owned by this user is created so ownership boundaries are real rather than simulated, and the real
// project is never modified or reassigned.
const reference = projectName
  ? await prisma.project.findFirst({ where: { name: projectName }, orderBy: { createdAt: "asc" } })
  : await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
if (!reference) fail("no existing deployed project was found to copy configuration from");

const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
const sourceVariables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];

const project = await prisma.project.upsert({
  where: { userId_slug: { userId, slug: "remote-verify" } },
  update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  create: { userId, name: "Remote Verify", slug: "remote-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
});
if (!sourceVariables.length) fail("no runtime variables were found to copy, so the remote container would be unconfigured");
log("   project:", project.name, "| repo:", project.localRepositoryPath, "| copied variables:", sourceVariables.length, "(secrets still encrypted:", sourceVariables.filter((v) => v.secret).length, ")");

const hostPort = Number(process.env.REMOTE_VERIFY_PORT || 8099);
const environment = await prisma.deploymentEnvironment.create({
  data: {
    projectId: project.id, name: "Remote Verify", slug: "remote-verify", type: "production",
    target: "remote", serverId: server.id, portScopeKey: `server:${server.id}`,
    hostPort, containerPort: 80, healthPath: "/", cpuLimit: "1.0", memoryLimit: "512m",
    runMigrations: process.env.VERIFY_MIGRATIONS === "1",
    runtimeVariables: { create: sourceVariables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
  },
});
log(`   environment: ${environment.slug} -> remote ${server.name} :${hostPort}`);
if (sourceVariables.filter((v) => v.secret).some((v) => v.value)) fail("a secret was stored in plaintext while copying");

// -------------------------------------------------------------------------------------------
// 3. Deploy for real
// -------------------------------------------------------------------------------------------
step(3, "real remote deployment");
const created = await createDeployment(project.id, environment.id);
log("   record:", created.id, "| target", created.target, "| bound to server:", created.serverId === server.id);
if (created.target !== "remote") fail("deployment target is not remote");
if (created.serverId !== server.id) fail("deployment is not bound to the registered server");

const started = Date.now();
let deployed;
try {
  deployed = await deployDeployment(created.id);
} catch (error) {
  deployed = await prisma.deployment.findUnique({ where: { id: created.id } });
  fail(`deployDeployment threw: ${error instanceof Error ? error.message : String(error)}`);
}
log(`   result after ${((Date.now() - started) / 1000).toFixed(1)}s: status=${deployed?.status} health=${deployed?.healthStatus} error=${deployed?.errorMessage ?? "-"}`);
if (deployed?.status !== "running") fail(`status is ${deployed?.status}`);

const streams = [...new Set((await prisma.deploymentLog.findMany({ where: { deploymentId: created.id }, select: { stream: true } })).map((s) => s.stream))];
log("   log streams:", streams.join(", "));
for (const required of ["validation", "build", "transfer", "remote_image", "container", "health"]) {
  if (!streams.includes(required)) fail(`missing log stream: ${required}`);
}
const transfer = await prisma.deployment.findUnique({ where: { id: created.id }, select: { transferBytes: true, transferStartedAt: true, transferCompletedAt: true, remoteImageTag: true } });
log("   transfer:", transfer?.transferBytes ? `${(Number(transfer.transferBytes) / 1024 / 1024).toFixed(1)} MB` : "none", "| remote tag:", transfer?.remoteImageTag);

// -------------------------------------------------------------------------------------------
// 4. Runtime projection and secret safety
// -------------------------------------------------------------------------------------------
step(4, "remote runtime projection");
if (deployed?.status === "running") {
  const runtime = await deploymentRuntime(created.id);
  log("   owned:", runtime.owned, "| target:", runtime.target, "| state:", runtime.container?.state, "| health:", runtime.container?.health);
  log("   image:", runtime.container?.image, "| ports:", runtime.container?.ports, "| mem:", runtime.container?.memoryUsage);
  if (!runtime.owned) fail("the runtime projection does not consider the container owned");
  if (runtime.container?.state !== "running") fail(`container state is ${runtime.container?.state}`);
  const serialized = JSON.stringify(runtime);
  for (const variable of sourceVariables.filter((v) => v.secret)) {
    if (variable.secretValue && serialized.includes(variable.secretValue)) fail(`secret ciphertext leaked into the runtime API`);
  }
  if (serialized.includes("APP_KEY=")) fail("a secret assignment reached the runtime API");
}

// -------------------------------------------------------------------------------------------
// 5. Restart, redeploy, rollback
// -------------------------------------------------------------------------------------------
step(5, "restart");
if (deployed?.status === "running") {
  const restarted = await restartDeployment(created.id);
  log("   restart ->", restarted.status, "/", restarted.healthStatus, "| restartedAt:", restarted.restartedAt ? "yes" : "no");
  if (restarted.status !== "running") fail(`restart ended at ${restarted.status}`);
}

if (process.env.VERIFY_ROLLBACK === "1" && deployed?.status === "running") {
  step(6, "redeploy");
  const redeployed = await redeployDeployment(created.id);
  log("   new record:", redeployed.id, "| target", redeployed.target, "| same server:", redeployed.serverId === server.id);
  if (redeployed.target !== "remote" || redeployed.serverId !== server.id) fail("redeploy lost the remote target or server");
  const redeployedResult = await deployDeployment(redeployed.id);
  log("   redeployed ->", redeployedResult.status, "/", redeployedResult.healthStatus);
  if (redeployedResult.status !== "running") fail(`redeploy failed: ${redeployedResult.errorMessage}`);

  step(7, "rollback to the known-good image already on the remote host");
  const candidates = await rollbackCandidates(redeployed.id);
  log("   candidates:", candidates.length, candidates.map((c) => c.id.slice(-6)).join(","));
  if (!candidates.length) fail("no rollback candidate was offered");
  else {
    const rolledBack = await rollbackDeployment(redeployed.id, candidates[0].id);
    log("   rollback ->", rolledBack.id, rolledBack.status, "/", rolledBack.healthStatus, "| rollbackOf:", rolledBack.rollbackOfId === redeployed.id);
    if (rolledBack.status !== "running") fail(`rollback failed: ${rolledBack.errorMessage}`);
    if (rolledBack.rollbackOfId !== redeployed.id) fail("rollback did not record its source deployment");
    const after = await prisma.deployment.findUnique({ where: { id: redeployed.id }, select: { status: true } });
    log("   source deployment now:", after.status);
    if (after.status !== "rolled_back") fail("the source deployment was not marked rolled_back");
  }
}

// -------------------------------------------------------------------------------------------
// 6. Cleanup unless the caller wants to inspect the result
// -------------------------------------------------------------------------------------------
step(8, "cleanup");
if (process.env.VERIFY_KEEP === "1" || problems.length) {
  log("   kept deployment:", created.id, "| environment:", environment.id, "| server:", server.id);
} else {
  const active = await prisma.deployment.findMany({ where: { environmentId: environment.id, containerName: { not: null } }, select: { id: true, status: true } });
  for (const item of active) await stopDeployment(item.id, "verification_cleanup").catch(() => undefined);
  await prisma.deployment.deleteMany({ where: { environmentId: environment.id } }).catch(() => undefined);
  await prisma.deploymentEnvironment.delete({ where: { id: environment.id } }).catch(() => undefined);
  await deleteServer(userId, server.id).catch((error) => fail(`server cleanup: ${error instanceof Error ? error.message : error}`));
  log("   stopped remote containers and removed the deployment, environment, and server");
}

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);
