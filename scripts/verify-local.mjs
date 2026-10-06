// Local regression: runs a REAL local deployment through the same refactored engine the remote target
// uses, on a separate port and environment, so the shared lifecycle, transfer no-op, release stage,
// health check, and cleanup are exercised end to end for the local target.
//
// The existing healthy GameVault deployment on port 8088 is never touched.
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
const { createDeployment, deployDeployment, restartDeployment, stopDeployment, deploymentRuntime } = await import("../src/lib/deployments/service.ts");

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);

const login = "local-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

for (const stale of await prisma.deploymentEnvironment.findMany({ where: { project: { userId } }, select: { id: true } })) {
  await prisma.deployment.deleteMany({ where: { environmentId: stale.id } });
  await prisma.deploymentEnvironment.delete({ where: { id: stale.id } }).catch(() => undefined);
}
await prisma.deployment.deleteMany({ where: { project: { userId } } });

// Reuse the real project's runtime variables so the container is configured like the real deployment.
const reference = await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
const variables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];
if (!variables.length) fail("no runtime variables found to copy");

const project = await prisma.project.upsert({
  where: { userId_slug: { userId, slug: "local-verify" } },
  update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  create: { userId, name: "Local Verify", slug: "local-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
});

const hostPort = Number(process.env.LOCAL_VERIFY_PORT || 8098);
const environment = await prisma.deploymentEnvironment.create({
  data: {
    projectId: project.id, name: "Local Verify", slug: "local-verify", type: "development",
    target: "local", hostPort, containerPort: 80, healthPath: "/", cpuLimit: "1.0", memoryLimit: "512m",
    runMigrations: true,
    runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
  },
});
log(`1. local environment on :${hostPort} with ${variables.length} variables, target=local`);

const created = await createDeployment(project.id, environment.id);
log("2. deployment record:", created.id, "| target", created.target, "| server", created.serverId ?? "none");
if (created.target !== "local") fail("target is not local");
if (created.serverId) fail("a local deployment must not be bound to a server");

const started = Date.now();
let deployed;
try { deployed = await deployDeployment(created.id); } catch (error) { deployed = await prisma.deployment.findUnique({ where: { id: created.id } }); fail(`threw: ${error instanceof Error ? error.message : error}`); }
log(`   deployed in ${((Date.now() - started) / 1000).toFixed(1)}s -> status=${deployed?.status} health=${deployed?.healthStatus}`);
if (deployed?.status !== "running") fail(`status is ${deployed?.status}: ${deployed?.errorMessage}`);

const streams = [...new Set((await prisma.deploymentLog.findMany({ where: { deploymentId: created.id }, select: { stream: true } })).map((s) => s.stream))];
log("   log streams:", streams.join(", "));
for (const required of ["validation", "build", "container", "release", "health"]) if (!streams.includes(required)) fail(`missing stream ${required}`);
// A local deployment performs no transfer.
for (const forbidden of ["transfer", "remote_image"]) if (streams.includes(forbidden)) fail(`local deployment emitted a remote-only stream: ${forbidden}`);
const transfer = await prisma.deployment.findUnique({ where: { id: created.id }, select: { transferBytes: true, transferStartedAt: true } });
if (transfer?.transferBytes || transfer?.transferStartedAt) fail("a local deployment recorded a transfer");

if (deployed?.status === "running") {
  const runtime = await deploymentRuntime(created.id);
  log("3. runtime:", runtime.container?.state, "| ports", runtime.container?.ports, "| image", runtime.container?.image);
  if (!runtime.owned || runtime.container?.state !== "running") fail("local runtime not healthy");
  if (JSON.stringify(runtime).includes("APP_KEY=")) fail("a secret assignment reached the runtime API");

  const restarted = await restartDeployment(created.id);
  log("4. restart ->", restarted.status, "/", restarted.healthStatus);
  if (restarted.status !== "running") fail(`restart ended at ${restarted.status}`);
}

log("\n5. cleanup");
await stopDeployment(created.id, "verification_cleanup").catch(() => undefined);
await prisma.deployment.deleteMany({ where: { environmentId: environment.id } }).catch(() => undefined);
await prisma.deploymentEnvironment.delete({ where: { id: environment.id } }).catch(() => undefined);
log("   removed the verification environment");

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);
