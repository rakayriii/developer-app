// Real end-to-end verification of Phase 12: application exposure over the reverse proxy.
//
// Deploys GameVault to a real remote host (Phase 11), then routes a hostname through a real Caddy
// container on that host and verifies it from outside the proxy's own configuration. Nothing is mocked:
// the image is built locally, transferred, loaded, started, migrated, and then actually proxied.
import { readFileSync, existsSync } from "node:fs";
import { request as httpsRequest } from "node:https";

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
const { createDeployment, deployDeployment, stopDeployment, restartDeployment, redeployDeployment, rollbackDeployment, rollbackCandidates } = await import("../src/lib/deployments/service.ts");
const { createDomain, disableDomain, enableDomain, getDomain, deleteDomain, reconcileServer } = await import("../src/lib/exposure/service.ts");
const { normalizeHostname } = await import("../src/lib/exposure/hostname.ts");
const { renderCaddyfile } = await import("../src/lib/exposure/caddy.ts");

/**
 * A real TLS request that reports what the handshake actually did.
 *
 * `rejectUnauthorized` stays on, so a certificate that does not chain to `ca`, or that was not issued for
 * `servername`, produces an error instead of a response. Connecting to 127.0.0.1 while asking for the
 * hostname forces SNI and certificate-name verification.
 */
function tlsProbe({ host, port, servername, path, ca }) {
  return new Promise((resolve) => {
    const request = httpsRequest({ host, port, path, ca, servername, servernameCheck: true }, (response) => {
      const socket = response.socket;
      const certificate = socket.getPeerCertificate?.() || {};
      resolve({
        status: response.statusCode,
        // Node verified the chain and the name against `servername`, so this already proves the
        // certificate was issued for this hostname rather than merely trusted.
        authorized: socket.authorized === true,
        cipher: socket.getCipher?.()?.name ?? "none",
        // Modern certificates carry the name only in the SAN, not the subject CN.
        names: String(certificate.subjectaltname ?? certificate.subject?.CN ?? ""),
        issuer: String(certificate.issuer?.O ?? certificate.issuer?.CN ?? ""),
        error: null,
      });
      response.resume();
    });
    request.on("error", (error) => resolve({ status: null, authorized: false, cipher: "none", subject: "", issuer: "", error: error.message }));
    request.setTimeout(15000, () => request.destroy(new Error("timed out")));
    request.end();
  });
}

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);
const step = (n, title) => log(`\n${n}. ${title}`);

const login = "exposure-verify-user";
const user = await prisma.user.upsert({ where: { githubLogin: login }, update: {}, create: { githubLogin: login } });
const userId = user.id;

let created = null;
let environment = null;
let server = null;

/**
 * Teardown that always runs.
 *
 * Containers are stopped through the normal deployment path before their rows are deleted, because
 * deleting a record first would orphan the container and leave the port claimed by something Developer
 * OS no longer knows it owns.
 */
async function teardown(reason) {
  log(`\n   cleanup (${reason})`);
  try {
    // Harness-only reclamation. An earlier failed run can leave a container with no database record, and
    // the application deliberately refuses to stop a container it has no record of. That refusal is correct
    // behaviour, so reclaiming the test host is done here explicitly, through the same fixed stop and
    // remove operations the application uses, over the same pinned SSH connection.
    if (process.env.RECLAIM_REMOTE === "1") {
      const hostname = process.env.REMOTE_HOST || "127.0.0.1";
      const port = Number(process.env.REMOTE_PORT || 2222);
      const hostKeyLine = readFileSync(`${process.env.SSHD_DIR}/host_key.pub`, "utf8").split("\n").filter(Boolean)[0].trim();
      const { openSshTransport } = await import("../src/lib/servers/ssh.ts");
      const { remoteDockerStop, remoteDockerRemove } = await import("../src/lib/deployments/remote/docker.ts");
      const transport = await openSshTransport({ hostname, port, username: process.env.REMOTE_USER || "root", privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"), hostKeyLine });
      try {
        const listing = await transport.run("docker ps --all --filter name=developer-os --format {{.Names}}");
        for (const name of listing.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
          if (!name.startsWith("developer-os-") || name.startsWith("developer-os-caddy-")) continue;
          await remoteDockerStop(transport, name).catch(() => undefined);
          await remoteDockerRemove(transport, name).catch(() => undefined);
          log(`   reclaimed orphaned container ${name}`);
        }
      } finally { await transport.close(); }
    }
    // Resolve the server even when this run has not registered one yet, so a previous run's leftovers
    // are removed rather than colliding with a fresh registration.
    const target = server ?? await prisma.server.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
    if (target) {
      for (const domain of await prisma.deploymentDomain.findMany({ where: { serverId: target.id } })) {
        await deleteDomain(userId, domain.id).catch(() => undefined);
      }
      const rows = environment
        ? await prisma.deployment.findMany({ where: { environmentId: environment.id } })
        : await prisma.deployment.findMany({ where: { environment: { project: { userId } } } });
      for (const row of rows) await stopDeployment(row.id, "exposure_verification_cleanup").catch(() => undefined);
      for (const env of environment ? [environment] : await prisma.deploymentEnvironment.findMany({ where: { project: { userId } } })) {
        await prisma.deploymentEnvironment.delete({ where: { id: env.id } }).catch(() => undefined);
      }
      await deleteServer(userId, target.id).catch(() => undefined);
    }
  } catch (error) {
    console.error("   cleanup error:", error instanceof Error ? error.message : error);
  }
  log("   done");
}

try {
// -------------------------------------------------------------------------------------------
step(1, "remote server: register, trust, verify");
// Remove anything a previous run left behind before claiming the port.
await teardown("pre-flight");
server = await createServer(userId, {
  name: "exposure-remote",
  hostname: process.env.REMOTE_HOST || "127.0.0.1",
  port: Number(process.env.REMOTE_PORT || 2222),
  username: process.env.REMOTE_USER || "root",
  authMethod: "key",
  privateKey: readFileSync(`${process.env.SSHD_DIR}/client_key`, "utf8"),
});
if (JSON.stringify(server).includes("PRIVATE KEY")) fail("the private key reached the public server projection");
await trustHostKey(userId, server.id);
const probe = await testServer(userId, server.id);
log("   online:", probe.server.status, "| docker", probe.server.dockerVersion, "| arch", probe.server.architecture);
if (probe.server.status !== "online" || !probe.server.dockerAvailable) fail("remote server is not usable");

// -------------------------------------------------------------------------------------------
step(2, "remote deployment of the real project");
const reference = await prisma.project.findFirst({ where: { deployments: { some: { status: "running" } } }, orderBy: { createdAt: "asc" } });
const referenceEnvironment = reference ? await prisma.deploymentEnvironment.findFirst({ where: { projectId: reference.id, target: "local" }, orderBy: { createdAt: "asc" } }) : null;
const variables = referenceEnvironment ? await prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId: referenceEnvironment.id } }) : [];
if (!variables.length) fail("no runtime variables found to copy");

const project = await prisma.project.upsert({
  where: { userId_slug: { userId, slug: "exposure-verify" } },
  update: { localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
  create: { userId, name: "Exposure Verify", slug: "exposure-verify", localRepositoryPath: reference?.localRepositoryPath ?? "GameVault" },
});
const hostPort = Number(process.env.EXPOSURE_PORT || 8097);
environment = await prisma.deploymentEnvironment.create({
  data: {
    projectId: project.id, name: "Exposure", slug: "exposure", type: "production",
    target: "remote", serverId: server.id, portScopeKey: `server:${server.id}`,
    hostPort, containerPort: 80, healthPath: "/", cpuLimit: "1.0", memoryLimit: "512m", runMigrations: true,
    runtimeVariables: { create: variables.map((v) => ({ name: v.name, secret: v.secret, value: v.value, secretValue: v.secretValue })) },
  },
});
log(`   environment -> remote ${server.name}:${hostPort}, ${variables.length} runtime variables (secrets encrypted: ${variables.filter((v) => v.secret).length})`);

created = await createDeployment(project.id, environment.id);
const deployed = await deployDeployment(created.id);
log("   deployment:", deployed.status, "/", deployed.healthStatus, `(${deployed.imageTag})`);
if (deployed.status !== "running") fail(`deployment is ${deployed.status}: ${deployed.errorMessage}`);

// -------------------------------------------------------------------------------------------
step(3, "hostname validation is enforced before anything is created");
{
  const rejected = [
    ["a protocol", "https://gamevault.test"],
    ["a path", "gamevault.test/app"],
    ["a port", "gamevault.test:8088"],
    ["a shell substitution", "gamevault.test$(id)"],
    ["a wildcard", "*.gamevault.test"],
    ["a malformed label", "-bad.gamevault.test"],
    ["an empty label", "gamevault..test"],
    ["localhost by default", "localhost"],
    ["a bare IP by default", "127.0.0.1"],
    ["a single label", "gamevault"],
  ];
  for (const [what, hostname] of rejected) {
    try { normalizeHostname(hostname); fail(`${what} was accepted: ${hostname}`); }
    catch { log(`   rejected ${what.padEnd(24)} ${hostname}`); }
  }
  // The API layer must refuse the same inputs.
  for (const hostname of ["http://evil.test", "gamevault.test;id"]) {
    try { await createDomain(userId, { deploymentId: created.id, hostname, allowLocal: true, allowIp: true }); fail(`the service accepted ${hostname}`); }
    catch (error) { log(`   service rejected ${hostname.padEnd(24)} ${error.code}`); }
  }
}

// -------------------------------------------------------------------------------------------
step(4, "route a hostname through the reverse proxy");
const hostname = process.env.EXPOSURE_HOSTNAME || "gamevault.test";
const domain = await createDomain(userId, { deploymentId: created.id, hostname, tlsMode: "internal_ca", tlsEnabled: true });
log(`   domain: ${domain.hostname} -> 127.0.0.1:${domain.upstreamPort} | status ${domain.status} (${domain.statusCode})`);
log(`   message: ${domain.statusMessage}`);
if (domain.hostname !== hostname.toLowerCase()) fail(`hostname was rewritten: ${domain.hostname}`);
if (domain.status !== "active") fail(`domain is ${domain.status}: ${domain.statusMessage}`);

// -------------------------------------------------------------------------------------------
step(5, "the proxy really serves the application");
{
  // Reach the published port on the remote host from here, exactly as an external client would.
  const overHttp = await fetch(`http://127.0.0.1/`, { headers: { Host: hostname }, redirect: "manual" }).catch((error) => ({ status: 0, statusText: error.message }));
  log(`   http://${hostname} via published :80 -> ${overHttp.status}`);
  if (overHttp.status < 200 || overHttp.status >= 400) fail(`proxy did not serve the app over HTTP (${overHttp.status})`);

  // TLS through the proxy, against Caddy's internal authority. The certificate is untrusted by default,
  // which is expected and is exactly why the root is reported below.
  const overTls = await fetch(`https://127.0.0.1/`, { headers: { Host: hostname }, redirect: "manual" }).catch(() => null);
  log(`   https://${hostname} with a strict trust store -> ${overTls ? overTls.status : "rejected (expected: internal CA is not publicly trusted)"}`);
  if (overTls) fail("the internal authority was unexpectedly trusted by a default client");

  const certificate = (await reconcileServer(server.id)).certificate || "";
  log(`   Caddy internal root certificate: ${certificate ? `${certificate.split("\n").length} lines, ${certificate.slice(0, 27)}...` : "not produced"}`);
  if (!certificate.includes("BEGIN CERTIFICATE")) fail("the proxy produced no root certificate for its internal authority");

  // The real TLS test: a client that trusts Caddy's root must complete a real handshake against the
  // published 443, for the right server name, and receive the application over HTTPS. Connecting to
  // 127.0.0.1 while asking for the hostname is what forces SNI and certificate-name checking, so a
  // certificate for some other hostname would be rejected rather than quietly accepted.
  const overTrustedTls = await tlsProbe({ host: "127.0.0.1", port: 443, servername: hostname, path: "/", ca: certificate });
  log(`   https://${hostname} trusting Caddy's root -> ${overTrustedTls.status} (cipher ${overTrustedTls.cipher}, ${overTrustedTls.names || "no SAN"})`);
  if (overTrustedTls.error) fail(`TLS handshake against the internal authority failed: ${overTrustedTls.error}`);
  if (overTrustedTls.status !== 200) fail(`the application did not answer over TLS (${overTrustedTls.status})`);
  if (!overTrustedTls.authorized) fail("the certificate did not verify against Caddy's own root");
  if (!overTrustedTls.names.includes(hostname)) fail(`the certificate names ${overTrustedTls.names || "(nothing)"}, not ${hostname}`);
  log(`   certificate SAN=${overTrustedTls.names} issuer=${overTrustedTls.issuer}`);

  // A hostname the authority never issued must not verify against the same root.
  const wrongName = await tlsProbe({ host: "127.0.0.1", port: 443, servername: "never-issued.gamevault.test", path: "/", ca: certificate });
  log(`   https://never-issued.gamevault.test with the same root -> ${wrongName.authorized ? "authorized (wrong)" : `rejected (${(wrongName.error || "").split("\n")[0]})`}`);
  if (wrongName.authorized) fail("the internal authority validated a hostname it never issued");
}

// -------------------------------------------------------------------------------------------
step(6, "second hostname on the same proxy, and removing one keeps the other");
const second = await createDomain(userId, { deploymentId: created.id, hostname: "alt.gamevault.test", tlsMode: "internal_ca" });
log(`   ${second.hostname} -> status ${second.status}`);
if (second.status !== "active") fail(`second domain is ${second.status}: ${second.statusMessage}`);

const firstStill = await getDomain(userId, domain.id);
if (firstStill.status !== "active") fail("adding a second domain disturbed the first");

await disableDomain(userId, second.id);
const afterDisable = await getDomain(userId, second.id);
const firstAfterDisable = await getDomain(userId, domain.id);
log(`   after disabling the second: it is ${afterDisable.status}, the first is ${firstAfterDisable.status}`);
if (afterDisable.status !== "disabled") fail(`disabled domain reports ${afterDisable.status}`);
if (firstAfterDisable.status !== "active") fail("disabling one domain took the other down with it");

// -------------------------------------------------------------------------------------------
step(7, "traffic follows the deployment lifecycle");
{
  const restarted = await restartDeployment(created.id);
  const afterRestart = await getDomain(userId, domain.id);
  log(`   restart -> ${restarted.status}; domain re-verified as ${afterRestart.status}`);
  if (afterRestart.status !== "active") fail(`domain is ${afterRestart.status} after a restart: ${afterRestart.statusMessage}`);

  const redeployed = await redeployDeployment(created.id);
  const redeployedResult = await deployDeployment(redeployed.id);
  log(`   redeploy -> ${redeployedResult.status}; old domain now ${(await getDomain(userId, domain.id)).status}`);
  if (redeployedResult.status !== "running") fail(`redeploy failed: ${redeployedResult.errorMessage}`);
  // The new container has a different id but the same published port, so the hostname must be re-pointed.
  const rebound = await enableDomain(userId, domain.id);
  log(`   hostname re-pointed at the new deployment -> ${rebound.status}`);
  if (rebound.status !== "active") fail(`hostname did not recover: ${rebound.status} ${rebound.statusMessage}`);
  log(`   (upstream now ${rebound.upstreamPort})`);

  const candidates = await rollbackCandidates(redeployed.id);
  if (candidates.length) {
    const rolledBack = await rollbackDeployment(redeployed.id, candidates[0].id);
    log(`   rollback -> ${rolledBack.status}`);
    await enableDomain(userId, domain.id);
    const afterRollback = await getDomain(userId, domain.id);
    log(`   hostname after rollback -> ${afterRollback.status}`);
    if (afterRollback.status !== "active") fail(`hostname did not recover after rollback: ${afterRollback.statusMessage}`);
  }
}

// -------------------------------------------------------------------------------------------
step(8, "the hostname follows the environment, and withdrawing that deployment withdraws the hostname");
{
  // The hostname tracks whatever deployment is currently serving the environment, so stopping some other
  // deployment of that environment must not affect it. Stopping the one actually answering must.
  const before = await getDomain(userId, domain.id);
  log(`   routed deployment is ${before.routedDeploymentId}`);

  if (before.routedDeploymentId === created.id) {
    await stopDeployment(created.id, "exposure_verification");
  } else {
    const other = (await prisma.deployment.findMany({ where: { environmentId: environment.id, id: { not: before.routedDeploymentId } } }))[0];
    if (other) {
      await stopDeployment(other.id, "exposure_verification").catch(() => undefined);
      const unaffected = await getDomain(userId, domain.id);
      log(`   stopping an unrelated deployment -> domain is still ${unaffected.status}`);
      if (unaffected.status !== "active") fail(`stopping an unrelated deployment withdrew the hostname: ${unaffected.status}`);
    }
    await stopDeployment(before.routedDeploymentId, "exposure_verification");
  }

  const withdrawn = await getDomain(userId, domain.id);
  log(`   serving deployment stopped -> domain is ${withdrawn.status} (${withdrawn.statusCode})`);
  if (withdrawn.status !== "disabled") fail(`a stopped deployment still routes: ${withdrawn.status}`);

  const served = await fetch(`http://127.0.0.1/`, { headers: { Host: hostname }, redirect: "manual" }).catch(() => ({ status: 0 }));
  log(`   http://${hostname} with nothing serving -> ${served.status}`);
  if (served.status !== 404 && served.status !== 502 && served.status !== 0) fail(`the proxy still routes a stopped deployment (${served.status})`);
}

// -------------------------------------------------------------------------------------------
step(9, "generated configuration");
{
  const routes = [{ hostname: "gamevault.test", upstreamPort: hostPort, tlsEnabled: true, tlsMode: "internal_ca", deploymentId: "example" }];
  const rendered = renderCaddyfile(routes);
  log(rendered.split("\n").map((line) => `   | ${line}`).join("\n"));
  if (!rendered.includes("admin localhost:2019")) fail("the admin endpoint is not bound to loopback");
  if (!rendered.includes("reverse_proxy 127.0.0.1:8097")) fail("the upstream is not the loopback published port");
}

} finally {
  await teardown("final");
}

await prisma.$disconnect();
log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);