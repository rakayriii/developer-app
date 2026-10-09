// Real verification of failure recovery: interrupted operations, duplicate prevention, and Caddy
// persistence through a proxy restart.
//
// Everything here uses disposable resources. The production GameVault deployment is only ever observed,
// never modified.
//
//   SSHD_DIR=/path VERIFY_MIGRATIONS=1 node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-recovery.mjs
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.GIT_WORKSPACE_ROOT ||= "/home/skywalker";
const run = promisify(execFile);

const { prisma } = await import("../src/lib/db.ts");
const { createServer, trustHostKey, testServer, deleteServer } = await import("../src/lib/servers/service.ts");
const { createDeployment, deployDeployment, stopDeployment } = await import("../src/lib/deployments/service.ts");
const { reconcileForUser } = await import("../src/lib/reliability/service.ts");
const { createDomain, getDomain, listDomains, deleteDomain } = await import("../src/lib/exposure/service.ts");
const { containerName } = await import("../src/lib/deployments/docker.ts");

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);
const step = (n, title) => log(`\n${n}. ${title}`);

const login = "recovery-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

let server = null;
let environment = null;

/**
 * Removes containers this verification left behind in an earlier run.
 *
 * The application is right to refuse a host port held by a container it has no record of, so a leftover
 * from a crashed run would make the next run fail for the wrong reason. Reclaiming the test host is a
 * harness responsibility, and it is done explicitly rather than by weakening that refusal.
 */
async function reclaimLocal() {
  const names = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"], { maxBuffer: 1 << 20 })).stdout
    .split("\n").map((line) => line.trim())
    .filter((name) => name.startsWith("developer-os-recovery-verify-"));
  for (const name of names) {
    await run("docker", ["rm", "--force", name]).catch(() => undefined);
    log(`   reclaimed ${name}`);
  }
}

async function teardown(reason) {
  log(`\n   cleanup (${reason})`);
  const target = server ?? await prisma.server.findFirst({ where: { userId } });
  if (target) {
    for (const domain of await prisma.deploymentDomain.findMany({ where: { serverId: target.id } })) await deleteDomain(userId, domain.id).catch(() => undefined);
  }
  for (const row of await prisma.deployment.findMany({ where: { project: { userId } } })) {
    await stopDeployment(row.id, "recovery_verification_cleanup").catch(() => undefined);
  }
  for (const env of await prisma.deploymentEnvironment.findMany({ where: { project: { userId } } })) {
    await prisma.deploymentEnvironment.delete({ where: { id: env.id } }).catch(() => undefined);
  }
  if (target) await deleteServer(userId, target.id).catch(() => undefined);
  log("   done");
}

try {
await reclaimLocal();

// -------------------------------------------------------------------------------------------
step(1, "an interrupted build is recovered without rebuilding");
{
  const reference = await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
  const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
  const variables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];

  const project = await prisma.project.upsert({
    where: { userId_slug: { userId, slug: "recovery-verify" } },
    update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
    create: { userId, name: "Recovery Verify", slug: "recovery-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  });
  environment = await prisma.deploymentEnvironment.create({
    data: {
      projectId: project.id, name: "Recovery", slug: "recovery", type: "production", target: "local",
      hostPort: Number(process.env.RECOVERY_PORT || 8094), containerPort: 80, healthPath: "/",
      cpuLimit: "1.0", memoryLimit: "512m", runMigrations: process.env.VERIFY_MIGRATIONS === "1",
      runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
    },
  });
  log(`   environment ready on :${environment.hostPort}`);

  // A record left mid-build by a shutdown, with no container behind it.
  const stuck = await createDeployment(project.id, environment.id);
  const name = containerName(project.slug, environment.slug, stuck.id);
  await prisma.deployment.update({ where: { id: stuck.id }, data: { status: "building", lastStage: "build" } });
  log(`   deployment ${stuck.id.slice(0, 12)} left at stage "build"`);

  const reports = [];
  for (const dryRun of [true, false]) {
    const report = await reconcileForUser(userId, { dryRun });
    reports.push({ dryRun, report });
    const finding = report.findings.find((item) => item.deploymentId === stuck.id);
    log(`   ${dryRun ? "dry run " : "applied  "}-> ${finding?.outcome} (${finding?.code}), corrections ${report.correctionsApplied}`);
    if (finding?.outcome !== "recovering") fail(`an interrupted build reconciled as ${finding?.outcome}`);
    if (finding?.code !== "container_lost_during_operation") fail(`classified as ${finding?.code}`);
  }
  if (reports[0].report.correctionsApplied !== 0) fail("the dry run applied a correction");

  const after = await prisma.deployment.findUnique({ where: { id: stuck.id }, select: { status: true } });
  log(`   record now: ${after.status}`);
  if (after.status !== "failed") fail(`an interrupted deployment was recorded as ${after.status}`);

  // Nothing was rebuilt and nothing was started.
  const names = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"])).stdout.split("\n").map((line) => line.trim());
  if (names.includes(name)) fail("reconciliation created the container; recovery must not rebuild");
  log(`   container ${name} was not created`);
  await prisma.deployment.delete({ where: { id: stuck.id } }).catch(() => undefined);
}

// -------------------------------------------------------------------------------------------
step(2, "a leftover container does not become a duplicate on retry");
{
  // A container created by an attempt whose outcome was never observed.
  const created = await createDeployment(environment.projectId, environment.id);
  const name = containerName((await prisma.project.findUniqueOrThrow({ where: { id: environment.projectId } })).slug, environment.slug, created.id);

  // Stand up a container under exactly this deployment's generated name, as a half-finished attempt would.
  await run("docker", ["run", "--detach", "--name", name, "-p", `${environment.hostPort}:80`, "--memory", "128m", "developer-os/gamevault:deployment-cmutp318s0001v1s6qf4qka26"]).catch((error) => log(`   (could not stand up a leftover: ${String(error.message).split("\n")[0].slice(0, 80)})`));
  const present = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"], { maxBuffer: 1 << 20 })).stdout.split("\n").map((line) => line.trim()).includes(name);
  log(`   leftover container ${name} present: ${present}`);
  if (!present) fail("could not create the leftover to test against");

  const deployed = await deployDeployment(created.id);
  log(`   deploy after the leftover -> ${deployed.status}/${deployed.healthStatus}`);
  if (deployed.status !== "running") fail(`the retry did not recover: ${deployed.errorMessage}`);

  const after = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"], { maxBuffer: 1 << 20 })).stdout.split("\n").map((line) => line.trim()).filter((line) => line === name);
  log(`   containers with that exact name after the retry: ${after.length}`);
  if (after.length !== 1) fail(`expected exactly one container named ${name}, found ${after.length}`);

  const record = await prisma.deployment.findUnique({ where: { id: created.id }, select: { containerName: true } });
  if (record.containerName !== name) fail(`the record points at ${record.containerName}`);
  await stopDeployment(created.id, "recovery_verification").catch(() => undefined);
  await prisma.deployment.delete({ where: { id: created.id } }).catch(() => undefined);
}

// -------------------------------------------------------------------------------------------
step(3, "Caddy configuration and domains survive a proxy restart");
if (process.env.SSHD_DIR && existsSync(`${process.env.SSHD_DIR}/client_key`)) {
  server = await createServer(userId, {
    name: "recovery-remote",
    hostname: process.env.REMOTE_HOST || "127.0.0.1",
    port: Number(process.env.REMOTE_PORT || 2222),
    username: process.env.REMOTE_USER || "root",
    authMethod: "key",
    privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
  });
  await trustHostKey(userId, server.id);
  const probe = await testServer(userId, server.id);
  if (probe.server.status !== "online") fail("the remote host is not usable for the proxy test");
  else log(`   remote host online (${probe.server.architecture})`);

  // A remote environment on a different port from the local one above.
  const reference = await prisma.project.findUniqueOrThrow({ where: { id: environment.projectId } });
  const referenceEnv = await prisma.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } });
  const variables = await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnv.id } });
  environment = await prisma.deploymentEnvironment.create({
    data: {
      projectId: reference.id, name: "RecoveryRemote", slug: "recovery-remote", type: "production", target: "remote",
      serverId: server.id, portScopeKey: `server:${server.id}`,
      hostPort: Number(process.env.RECOVERY_REMOTE_PORT || 8093), containerPort: 80, healthPath: "/",
      cpuLimit: "1.0", memoryLimit: "512m", runMigrations: process.env.VERIFY_MIGRATIONS === "1",
      runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
    },
  });
  log(`   remote environment on :${environment.hostPort}`);

  const created = await createDeployment(reference.id, environment.id);
  const deployed = await deployDeployment(created.id);
  if (deployed.status !== "running") fail(`the remote deployment did not run: ${deployed.errorMessage}`);

  const hostname = "recovery.gamevault.test";
  const domain = await createDomain(userId, { deploymentId: created.id, hostname, tlsMode: "internal_ca" });
  log(`   domain ${domain.hostname} -> ${domain.status}`);
  if (domain.status !== "active") fail(`the domain did not activate: ${domain.statusMessage}`);

  // Restart the proxy container, exactly as a host reboot would.
  const { openSshTransport } = await import("../src/lib/servers/ssh.ts");
  const { caddyContainerName } = await import("../src/lib/deployments/remote/caddy.ts");
  const transport = await openSshTransport({
    hostname: process.env.REMOTE_HOST || "127.0.0.1",
    port: Number(process.env.REMOTE_PORT || 2222),
    username: process.env.REMOTE_USER || "root",
    privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
    hostKeyLine: readFileSync(`${process.env.SSHD_DIR}/host_key.pub`, "utf8").split("\n").filter(Boolean)[0].trim(),
  });
  try {
    const caddyName = caddyContainerName(server.id);
    await transport.run(`docker restart ${caddyName}`);
    log(`   proxy container restarted`);
    await new Promise((resolve) => setTimeout(resolve, 6000));

    const served = await fetch("http://127.0.0.1/", { headers: { Host: hostname }, redirect: "manual" }).then((response) => response.status).catch(() => 0);
    log(`   http://${hostname} after the proxy restart -> ${served}`);
    if (!served) fail("the hostname stopped serving after the proxy restarted");

    // The certificate survives because the data directory is host-mounted.
    const certificate = await fetch(`https://127.0.0.1/`, { headers: { Host: hostname } }).catch(() => null);
    log(`   https with a strict trust store -> ${certificate ? "unexpectedly trusted" : "rejected (expected: internal CA)"}`);

    // The domain record is intact and still associated.
    const after = await getDomain(userId, domain.id);
    log(`   domain record after restart: ${after.status}, upstream ${after.upstreamPort}`);
    if (after.hostname !== hostname) fail("the domain association changed across the restart");

    // Reconciliation must not report drift when nothing changed.
    const report = await reconcileForUser(userId);
    const drift = report.findings.filter((finding) => finding.code === "proxy_configuration_drift");
    log(`   proxy configuration drift findings: ${drift.length}`);
    if (drift.length) fail("reconciliation reported drift immediately after a restart that preserved the configuration");

    // Removing the upstream withdraws the route but keeps the domain record.
    await stopDeployment(created.id, "recovery_verification");
    const withdrawn = await getDomain(userId, domain.id);
    log(`   after stopping the deployment: domain is ${withdrawn.status} (${withdrawn.statusCode})`);
    if (withdrawn.status !== "disabled") fail(`stopping the deployment left the domain as ${withdrawn.status}`);
    const stillListed = await listDomains(userId);
    if (!stillListed.some((entry) => entry.id === domain.id)) fail("the domain record was deleted when its upstream went away");
    log("   the domain record was preserved");
  } finally {
    await transport.close().catch(() => undefined);
  }
} else {
  log("   skipped: no SSHD_DIR, so the disposable remote host is unavailable");
}
} finally {
  await teardown("final");
}

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);