// Application exposure: routing a hostname on a registered server to one deployment's published port.
//
// The proxy is a shared, server-scoped resource. That single fact drives the design here: a domain is never
// applied on its own, because writing one site block without the others would silently drop traffic for every
// other domain on that server. Every change reconciles the whole set for the affected server, and the
// configuration is only adopted once Caddy has validated it.

import { prisma } from "@/lib/db";
import { RemoteDeploymentError } from "@/lib/deployments/remote/errors.ts";
import { openRemoteDeployment } from "@/lib/deployments/remote/server.ts";
import { remoteEnsureCaddy, remoteProbeRoute, remoteReadCaddyRootCertificate, remoteRemoveCaddy, remoteWriteAndReloadCaddy } from "@/lib/deployments/remote/proxy.ts";
import { configHash, describeRoute, isCaddyTlsMode, renderCaddyfile, type ProxyRoute } from "./caddy.ts";
import { normalizeHostname, type HostnameOptions } from "./hostname.ts";

export type DomainStatusValue = "pending" | "active" | "failed" | "disabled";

/** The public projection. A domain record never exposes anything but its own routing intent. */
export type PublicDomain = {
  id: string;
  deploymentId: string;
  serverId: string;
  hostname: string;
  tlsEnabled: boolean;
  tlsMode: string;
  status: DomainStatusValue;
  statusCode: string | null;
  statusMessage: string | null;
  routedDeploymentId: string | null;
  upstreamPort: number | null;
  serverName: string | null;
  deploymentStatus: string | null;
  createdAt: string;
  lastCheckedAt: string | null;
};

export class DomainError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
  }
}

// A deployment must actually be serving before traffic can be pointed at it. Routing to a container that is
// not running would publish a connection-refused page under the operator's hostname.
const routableStatuses = ["running", "unhealthy"] as const;

/**
 * The currently serving deployment for each of the given environments.
 *
 * Newest wins, because redeploying stops the deployment it replaced, and a rollback stops the newer one
 * again. One query covers every environment involved.
 */
async function servingDeployments(environmentIds: readonly string[]) {
  const unique = [...new Set(environmentIds)];
  if (!unique.length) return new Map();
  const live = await prisma.deployment.findMany({
    where: { environmentId: { in: unique }, status: { in: [...routableStatuses] }, containerName: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, environmentId: true, status: true },
  });
  const byEnvironment = new Map<string, { id: string; environmentId: string; status: string }>();
  for (const candidate of live) if (!byEnvironment.has(candidate.environmentId)) byEnvironment.set(candidate.environmentId, candidate);
  return byEnvironment;
}

/**
 * The routes a server's proxy should currently carry.
 *
 * A hostname is attached to an *environment*, not to one container. Redeploying replaces the deployment
 * record and the container behind it while keeping the environment's published port, so the hostname has to
 * follow the environment's currently serving deployment rather than the record it was created against.
 * Resolving it against the anchor record instead would withdraw every hostname the moment a redeploy
 * succeeded, even though the new container was serving on exactly the same port.
 *
 * A hostname is omitted rather than routed to a dead port, and reported as disabled, when nothing on its
 * environment is serving. That is what makes a stop withdraw traffic instead of serving a 502.
 */
async function routesForServer(serverId: string) {
  const domains = await prisma.deploymentDomain.findMany({
    where: { serverId },
    orderBy: { hostname: "asc" },
    include: { deployment: { select: { id: true, status: true, environmentId: true, environment: { select: { hostPort: true } } } } },
  });

  const servingByEnvironment = await servingDeployments(domains.map((domain) => domain.deployment.environmentId));

  const routes: ProxyRoute[] = [];
  const withdrawn: string[] = [];

  for (const domain of domains) {
    const current = servingByEnvironment.get(domain.deployment.environmentId) ?? null;
    if (domain.status !== "disabled" && !current) withdrawn.push(domain.id);
    if (domain.status === "disabled" || !current) continue;
    routes.push({
      hostname: domain.hostname,
      upstreamPort: domain.deployment.environment.hostPort,
      tlsEnabled: domain.tlsEnabled,
      tlsMode: domain.tlsMode,
      deploymentId: current.id,
    });
  }

  return { routes, withdrawn, count: domains.length };
}

function toPublic(domain: {
  id: string; deploymentId: string; serverId: string; hostname: string; tlsEnabled: boolean; tlsMode: string;
  status: string; statusCode: string | null; statusMessage: string | null;
  deployment: { status: string };
  createdAt: Date; lastCheckedAt: Date | null;
}, upstreamPort: number | null, serverName: string | null, routed: { id: string; status: string } | null): PublicDomain {
  return {
    id: domain.id,
    deploymentId: domain.deploymentId,
    // The deployment actually answering for this hostname. It follows the environment across a redeploy
    // or rollback, so it can differ from deploymentId, which stays as the record the operator chose.
    routedDeploymentId: routed?.id ?? null,
    serverId: domain.serverId,
    hostname: domain.hostname,
    tlsEnabled: domain.tlsEnabled,
    tlsMode: domain.tlsMode,
    status: domain.status as DomainStatusValue,
    statusCode: domain.statusCode ?? null,
    statusMessage: domain.statusMessage ?? null,
    upstreamPort,
    serverName,
    deploymentStatus: routed?.status ?? domain.deployment.status,
    createdAt: domain.createdAt.toISOString(),
    lastCheckedAt: domain.lastCheckedAt ? domain.lastCheckedAt.toISOString() : null,
  };
}

const domainInclude = {
  server: { select: { id: true, name: true } },
  deployment: { select: { id: true, status: true, environmentId: true, environment: { select: { hostPort: true } } } },
} as const;

/** Projects rows, resolving each hostname to the deployment that is actually serving it. */
async function project(rows: (Awaited<ReturnType<typeof loadDomains>>)[number][]) {
  const serving = await servingDeployments(rows.map((row) => row.deployment.environmentId));
  return rows.map((row) => toPublic(row, row.deployment.environment.hostPort, row.server.name, serving.get(row.deployment.environmentId) ?? null));
}

const loadDomains = (where: Record<string, unknown>) =>
  prisma.deploymentDomain.findMany({ where, include: domainInclude, orderBy: { createdAt: "asc" } });

export async function listDomains(userId: string, deploymentId?: string) {
  return project(await loadDomains({ server: { userId }, ...(deploymentId ? { deploymentId } : {}) }));
}

/**
 * Validates and creates a domain.
 *
 * Ownership is resolved in one query that must match the user, the project, and the deployment, so a domain
 * can never be attached to somebody else's deployment or to a deployment on a server they do not own.
 */
export async function createDomain(userId: string, input: Record<string, unknown>) {
  const normalized = normalizeHostname(input.hostname, { allowLocal: input.allowLocal === true, allowIp: input.allowIp === true });

  const tlsEnabled = input.tlsEnabled === undefined ? true : Boolean(input.tlsEnabled);
  const tlsMode = input.tlsMode === undefined ? (tlsEnabled ? "internal_ca" : "none") : input.tlsMode;
  if (!isCaddyTlsMode(tlsMode)) throw new DomainError("invalid_tls_mode", "TLS mode must be none, internal_ca, or automatic.", 400);
  if (!tlsEnabled && tlsMode !== "none") throw new DomainError("invalid_tls_mode", "TLS is disabled, so the mode must be none.", 400);

  const deployment = await prisma.deployment.findFirst({
    where: {
      id: typeof input.deploymentId === "string" ? input.deploymentId : "",
      target: "remote",
      project: { userId },
      // The domain is routed on the same server the deployment actually runs on. Taking a separate serverId
      // from the request would let an operator route a hostname at a host that does not serve the app.
      serverId: typeof input.serverId === "string" ? input.serverId : undefined,
    },
    include: { server: { select: { id: true, name: true } }, environment: { select: { hostPort: true } } },
  });
  if (!deployment) throw new DomainError("domain_deployment_not_found", "That deployment was not found, or is not a remote deployment you own.", 404);
  if (!deployment.serverId) throw new DomainError("domain_server_required", "That deployment is not bound to a server.", 409);
  if (!deployment.server) throw new DomainError("domain_server_required", "That deployment's server is no longer registered.", 409);

  const conflict = await prisma.deploymentDomain.findUnique({ where: { serverId_hostname: { serverId: deployment.serverId, hostname: normalized.hostname } } });
  if (conflict) throw new DomainError("domain_already_exists", "That hostname is already routed on this server.", 409);

  const created = await prisma.deploymentDomain.create({
    data: {
      deploymentId: deployment.id,
      serverId: deployment.serverId,
      hostname: normalized.hostname,
      // Persisted so a later read can tell an operator that a local name was deliberately permitted.
      allowLocal: normalized.local || normalized.address,
      tlsEnabled,
      tlsMode,
      status: "pending",
    },
    include: domainInclude,
  });

  await reconcileServer(deployment.serverId);
  return getDomain(userId, created.id);
}

/**
 * Rewrites the proxy configuration for one server so it reflects exactly its current domains.
 *
 * Runs entirely on the recorded domains rather than on a caller-supplied list, so a caller cannot route a
 * hostname they do not own, and a withdrawn domain is removed rather than left serving.
 */
export async function reconcileServer(serverId: string) {
  const server = await prisma.server.findUnique({ where: { id: serverId }, select: { id: true, userId: true, name: true } });
  if (!server) throw new DomainError("server_not_found", "The server was not found.", 404);

  const { routes, withdrawn, count } = await routesForServer(serverId);

  // A deployment that stopped can no longer be routed, so its domain is withdrawn rather than left
  // pointing at a container that no longer exists.
  if (withdrawn.length) {
    await prisma.deploymentDomain.updateMany({ where: { id: { in: withdrawn } }, data: { status: "disabled", statusCode: "deployment_not_serving", statusMessage: "The deployment is no longer serving, so this hostname was withdrawn.", lastCheckedAt: new Date() } });
  }

  // With nothing routed the proxy is stopped and removed. Leaving it running would hold ports 80 and 443
  // for no reason, and would block any other proxy on the host. Its data directory is kept, so
  // certificates survive and re-enabling a hostname does not have to start from nothing.
  if (!routes.length) {
    if (!count) return { routes: 0, reconciled: false, withdrawn: withdrawn.length, message: "This server has no domains." };
    const context = await openRemoteDeployment(server.userId, serverId);
    try {
      await remoteEnsureCaddy(context.transport, serverId);
      await remoteRemoveCaddy(context.transport, serverId, false);
      return { routes: 0, reconciled: true, withdrawn: withdrawn.length, proxyRemoved: true, message: "No active domains remain, so the reverse proxy was removed." };
    } finally {
      await context.transport.close();
    }
  }

  const contents = renderCaddyfile(routes);
  const hash = configHash(contents);
  const context = await openRemoteDeployment(server.userId, serverId);
  try {
    await remoteEnsureCaddy(context.transport, serverId);
    const reloadNote = await remoteWriteAndReloadCaddy(context.transport, serverId, contents);

    const results = [];
    for (const route of routes) {
      const probe = await remoteProbeRoute(context.transport, route.hostname, route.tlsEnabled && route.tlsMode !== "none");
      results.push({ domain: await prisma.deploymentDomain.findFirst({ where: { serverId, hostname: route.hostname } }), probe, route });
    }

    for (const result of results) {
      if (!result.domain) continue;
      await prisma.deploymentDomain.update({
        where: { id: result.domain.id },
        data: {
          status: result.probe.ok ? "active" : "failed",
          statusCode: result.probe.ok ? result.probe.status?.toString() ?? "200" : "proxy_unreachable",
          statusMessage: result.probe.ok ? `Routed to 127.0.0.1:${result.route.upstreamPort} over ${result.probe.scheme.toUpperCase()}.` : result.probe.message,
          configHash: hash,
          lastCheckedAt: new Date(),
        },
      });
    }

    const certificate = routes.some((route) => route.tlsEnabled && route.tlsMode === "internal_ca")
      ? await remoteReadCaddyRootCertificate(context.transport, serverId).catch(() => "")
      : "";

    return { routes: routes.length, reconciled: true, withdrawn: withdrawn.length, configHash: hash, reloadNote, certificate };
  } finally {
    await context.transport.close();
  }
}

export async function enableDomain(userId: string, id: string) {
  const domain = await ownedDomain(userId, id);
  await prisma.deploymentDomain.update({ where: { id }, data: { status: "pending", statusCode: null, statusMessage: null } });
  await reconcileServer(domain.serverId);
  return getDomain(userId, id);
}

export async function disableDomain(userId: string, id: string) {
  const domain = await ownedDomain(userId, id);
  await prisma.deploymentDomain.update({ where: { id }, data: { status: "disabled", statusCode: "disabled", statusMessage: "This hostname is not being routed." } });
  await reconcileServer(domain.serverId);
  return getDomain(userId, id);
}

export async function deleteDomain(userId: string, id: string) {
  const domain = await ownedDomain(userId, id);
  await prisma.deploymentDomain.delete({ where: { id } });
  await reconcileServer(domain.serverId);
  return { ok: true };
}

export async function getDomain(userId: string, id: string) {
  const rows = await loadDomains({ id, server: { userId } });
  if (!rows.length) throw new DomainError("domain_not_found", "That domain was not found.", 404);
  return (await project(rows))[0];
}

/** A domain is visible only to the owner of the server it routes on, which is also the owner of the deployment. */
async function ownedDomain(userId: string, id: string) {
  const domain = await prisma.deploymentDomain.findFirst({ where: { id, server: { userId } } });
  if (!domain) throw new DomainError("domain_not_found", "That domain was not found.", 404);
  return domain;
}

/**
 * Brings the proxy in line after a deployment settles.
 *
 * Called from the deployment lifecycle because a hostname is only withdrawn when something reconciles it.
 * Without this, stopping a deployment would leave the proxy routing to a container that no longer exists,
 * and the withdrawal would not happen until an unrelated domain change happened to trigger a reconcile.
 *
 * Best-effort by design: the deployment has already succeeded or failed on its own terms, and an
 * unreachable proxy must not retroactively turn a successful stop into a failure.
 */
export async function reconcileForDeployment(deploymentId: string) {
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { serverId: true, environment: { select: { target: true } } } });
  // Only a remote deployment can be routed; a local one has no proxy on any server.
  if (!deployment?.serverId || deployment.environment.target !== "remote") return;
  await reconcileServer(deployment.serverId).catch(() => undefined);
}

/** Reconciles every server that currently routes a domain for this user. */
export async function reconcileAllForUser(userId: string) {
  const servers = await prisma.server.findMany({ where: { userId, domains: { some: {} } }, select: { id: true } });
  const results = [];
  for (const server of servers) {
    try { results.push({ serverId: server.id, ...(await reconcileServer(server.id)) }); }
    catch (error) { results.push({ serverId: server.id, error: error instanceof RemoteDeploymentError ? error.code : "reconcile_failed" }); }
  }
  return results;
}

/** Removes the proxy from a server. Only offered when no domains remain to be routed. */
export async function removeProxy(userId: string, serverId: string) {
  const server = await prisma.server.findFirst({ where: { id: serverId, userId }, select: { id: true } });
  if (!server) throw new DomainError("server_not_found", "The server was not found.", 404);
  const remaining = await prisma.deploymentDomain.count({ where: { serverId } });
  if (remaining) throw new DomainError("server_in_use", `This server still routes ${remaining} hostname(s). Remove them first.`, 409);
  const context = await openRemoteDeployment(userId, serverId);
  try { await remoteRemoveCaddy(context.transport, serverId, true); return { ok: true }; }
  finally { await context.transport.close(); }
}

export { describeRoute, renderCaddyfile, normalizeHostname };
export type { HostnameOptions };