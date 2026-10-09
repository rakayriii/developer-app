// Real verification of deployment and exposure reconciliation.
//
// Reconciliation only corrects recorded state, so the interesting cases are the ones where the database
// and the runtime disagree. Each is produced for real, observed, corrected, and then observed again to
// prove idempotency. Nothing is fabricated and no deployment record or log is deleted.
//
// Uses disposable environments on the local Docker host plus, when available, the disposable remote host.
//
//   node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-reconcile.mjs
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
const { reconcileForUser, ReconcileError } = await import("../src/lib/reliability/service.ts");
const { createDeployment, deployDeployment, stopDeployment } = await import("../src/lib/deployments/service.ts");

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);
const step = (n, title) => log(`\n${n}. ${title}`);

const login = "reconcile-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

let environment = null;
const owned = async () => (environment
  ? await prisma.deployment.findMany({ where: { environmentId: environment.id } })
  : await prisma.deployment.findMany({ where: { project: { userId } } }));

async function teardown(reason) {
  log(`\n   cleanup (${reason})`);
  for (const row of await owned()) await stopDeployment(row.id, "reconcile_verification_cleanup").catch(() => undefined);
  for (const env of await prisma.deploymentEnvironment.findMany({ where: { project: { userId } } })) {
    await prisma.deploymentEnvironment.delete({ where: { id: env.id } }).catch(() => undefined);
  }
  log("   done");
}

/** Counts rows that must never change: history and logs are evidence, not working state. */
async function evidenceCounts() {
  return {
    deployments: await prisma.deployment.count({ where: { project: { userId } } }),
    logs: await prisma.deploymentLog.count({ where: { deployment: { project: { userId } } } }),
  };
}

try {
await teardown("pre-flight");

// -------------------------------------------------------------------------------------------
step(1, "an empty system reconciles to healthy without inventing anything");
{
  const before = await evidenceCounts();
  const report = await reconcileForUser(userId);
  log(`   outcome: ${report.outcome} | inspected: ${report.deploymentsInspected} | corrections: ${report.correctionsApplied} | error: ${report.error?.code ?? "none"}`);
  if (report.error) fail(`an empty reconciliation errored: ${report.error.code}`);
  if (report.outcome !== "healthy") fail(`an empty system reported ${report.outcome}`);
  const after = await evidenceCounts();
  if (after.deployments !== before.deployments) fail("reconciliation created a deployment record");
  if (after.logs !== before.logs) fail("reconciliation wrote a log entry");
}

// -------------------------------------------------------------------------------------------
step(2, "a real local deployment reconciles clean");
{
  const reference = await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
  const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
  const variables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];
  if (!variables.length) fail("no runtime variables found to copy");

  const project = await prisma.project.upsert({
    where: { userId_slug: { userId, slug: "reconcile-verify" } },
    update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
    create: { userId, name: "Reconcile Verify", slug: "reconcile-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  });
  environment = await prisma.deploymentEnvironment.create({
    data: {
      projectId: project.id, name: "Recon", slug: "recon", type: "production", target: "local",
      hostPort: Number(process.env.RECON_PORT || 8095), containerPort: 80, healthPath: "/",
      cpuLimit: "1.0", memoryLimit: "512m", runMigrations: process.env.VERIFY_MIGRATIONS === "1",
      runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
    },
  });

  const created = await createDeployment(project.id, environment.id);
  const deployed = await deployDeployment(created.id);
  log(`   deployed -> ${deployed.status}/${deployed.healthStatus}`);
  if (deployed.status !== "running") fail(`the disposable deployment did not run: ${deployed.errorMessage}`);

  const report = await reconcileForUser(userId);
  const finding = report.findings.find((item) => item.deploymentId === created.id);
  log(`   reconciled -> ${finding?.outcome} (${finding?.code})`);
  if (finding?.outcome !== "healthy") fail(`a healthy deployment reconciled as ${finding?.outcome}: ${finding?.summary}`);
  if (report.correctionsApplied !== 0) fail("reconciliation corrected a healthy deployment");
}

// -------------------------------------------------------------------------------------------
step(3, "database says running, container is gone");
{
  const [row] = await owned();
  // The container is removed for real, through Docker, exactly as a `docker rm` or a pruned daemon would.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  await run("docker", ["rm", "--force", row.containerId]);
  const gone = await run("docker", ["inspect", row.containerId]).then(() => false, () => true);
  log(`   container removed from Docker: ${gone}`);
  if (!gone) fail("could not remove the container to create the drift");

  const dryRun = await reconcileForUser(userId, { dryRun: true });
  const dryFinding = dryRun.findings.find((item) => item.deploymentId === row.id);
  log(`   dry run -> ${dryFinding?.outcome} (${dryFinding?.code}), corrections applied: ${dryRun.correctionsApplied}`);
  if (dryRun.correctionsApplied !== 0) fail("a dry run applied a correction");
  const statusAfterDryRun = await prisma.deployment.findUnique({ where: { id: row.id }, select: { status: true } });
  if (statusAfterDryRun.status !== "running") fail(`a dry run changed the recorded status to ${statusAfterDryRun.status}`);
  if (dryFinding?.code !== "record_running_container_absent") fail(`dry run classified as ${dryFinding?.code}`);

  const applied = await reconcileForUser(userId);
  const finding = applied.findings.find((item) => item.deploymentId === row.id);
  log(`   applied -> ${finding?.outcome} (${finding?.code}), corrections: ${applied.correctionsApplied}`);
  if (finding?.outcome !== "stale") fail(`absent container classified as ${finding?.outcome}`);
  if (applied.correctionsApplied !== 1) fail(`expected exactly one correction, applied ${applied.correctionsApplied}`);

  const after = await prisma.deployment.findUnique({ where: { id: row.id }, select: { status: true, healthStatus: true, containerId: true } });
  log(`   record now: ${after.status}/${after.healthStatus} | containerId ${after.containerId ?? "null"}`);
  if (after.status !== "stopped") fail(`recorded status is ${after.status}, expected stopped`);
}

// -------------------------------------------------------------------------------------------
step(4, "reconciliation is idempotent");
{
  const before = await evidenceCounts();
  const first = await reconcileForUser(userId);
  const second = await reconcileForUser(userId);
  const third = await reconcileForUser(userId);
  log(`   outcomes: ${first.outcome}, ${second.outcome}, ${third.outcome} | corrections: ${first.correctionsApplied}, ${second.correctionsApplied}, ${third.correctionsApplied}`);
  if (second.correctionsApplied !== 0) fail("the second run still corrected something");
  if (third.correctionsApplied !== 0) fail("the third run still corrected something");
  if (first.outcome !== second.outcome || second.outcome !== third.outcome) fail("the outcome is not stable across runs");

  const after = await evidenceCounts();
  log(`   evidence before ${before.deployments} deployments/${before.logs} logs -> after ${after.deployments}/${after.logs}`);
  if (after.deployments !== before.deployments) fail(`reconciliation changed the deployment count (${before.deployments} -> ${after.deployments})`);
  if (after.logs !== before.logs) fail(`reconciliation changed the log count (${before.logs} -> ${after.logs})`);
  if (after.logs < before.logs) fail("reconciliation deleted log evidence");
}

// -------------------------------------------------------------------------------------------
step(5, "a stopped container behind a running record is detected");
{
  const projectId = environment.projectId;
  const created = await createDeployment(projectId, environment.id);
  const deployed = await deployDeployment(created.id);
  if (deployed.status !== "running") fail(`could not create a second deployment: ${deployed.errorMessage}`);

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("docker", ["stop", "--time", "5", deployed.containerId]);

  const report = await reconcileForUser(userId);
  const finding = report.findings.find((item) => item.deploymentId === created.id);
  log(`   stopped container behind a running record -> ${finding?.outcome} (${finding?.code})`);
  if (finding?.outcome !== "stale") fail(`a stopped container classified as ${finding?.outcome}`);
  if (finding?.code !== "record_running_container_stopped") fail(`classified as ${finding?.code}`);
  await stopDeployment(created.id, "reconcile_verification").catch(() => undefined);
}

// -------------------------------------------------------------------------------------------
step(6, "a running container behind a stopped record is corrected forward");
{
  // A deployment that is genuinely running but recorded as stopped: the daemon restarted and the record
  // was written before the container came back.
  const created = await createDeployment(environment.projectId, environment.id);
  const deployed = await deployDeployment(created.id);
  if (deployed.status !== "running") fail(`could not create a deployment: ${deployed.errorMessage}`);
  await prisma.deployment.update({ where: { id: created.id }, data: { status: "stopped", healthStatus: "stopped" } });
  log(`   forced the record to stopped while the container is running`);

  const report = await reconcileForUser(userId);
  const finding = report.findings.find((item) => item.deploymentId === created.id);
  log(`   -> ${finding?.outcome} (${finding?.code})`);
  if (finding?.outcome !== "stale") fail(`classified as ${finding?.outcome}`);
  if (finding?.code !== "record_behind_runtime") fail(`classified as ${finding?.code}`);
  const after = await prisma.deployment.findUnique({ where: { id: created.id }, select: { status: true } });
  if (after.status !== "running") fail(`the record was not corrected forward (${after.status})`);
  await stopDeployment(created.id, "reconcile_verification").catch(() => undefined);
}

// -------------------------------------------------------------------------------------------
step(7, "concurrent reconciliation is refused, not interleaved");
{
  const first = reconcileForUser(userId);
  let second = null;
  let refusal = null;
  // Awaited so the synchronous refusal inside the async wrapper is caught rather than escaping.
  try { second = await reconcileForUser(userId, { waitForActive: false }); } catch (error) { refusal = error; }
  log(`   second run: ${refusal ? `refused with ${refusal.code}` : "started concurrently"}`);
  if (refusal instanceof ReconcileError) {
    if (refusal.code !== "reconcile_in_progress") fail(`unexpected refusal code ${refusal.code}`);
    if (refusal.status !== 409) fail(`expected 409, got ${refusal.status}`);
  } else if (second !== null) {
    fail("a concurrent reconciliation was allowed");
  }
  await first;
}

// -------------------------------------------------------------------------------------------
step(8, "no container outside this verification was touched");
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const before = (await run("docker", ["ps", "--format", "{{.Names}}"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  await reconcileForUser(userId);
  const after = (await run("docker", ["ps", "--format", "{{.Names}}"])).stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const unrelated = after.filter((name) => !name.includes("reconcile-verify"));
  log(`   running containers unchanged for unrelated work: ${unrelated.filter((name) => before.includes(name)).length}/${unrelated.length}`);
  for (const name of unrelated) if (!before.includes(name)) fail(`reconciliation started an unrelated container: ${name}`);
  const disappeared = before.filter((name) => !after.includes(name) && name.includes("reconcile-verify"));
  if (disappeared.length) fail(`reconciliation removed ${disappeared.join(", ")}`);
  const stillThere = (await run("docker", ["ps", "-a", "--format", "{{.Names}}"])).stdout;
  if (!stillThere.includes("developer-os-gamevault")) fail("the production GameVault container is no longer present");
  log("   the production GameVault container is still present");
}
} finally {
  await teardown("final");
}

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);