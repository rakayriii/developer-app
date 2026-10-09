// Deployment and exposure state reconciliation.
//
// Reads what is actually true from Docker and the network, compares it against what the database
// recorded, and corrects only what is safe and unambiguous. The rules live in classify.ts; this file is
// the part that talks to Docker, SSH, and Prisma.
//
// Safety properties this file is responsible for:
//
//   - Idempotent. Running it twice produces the same result and creates nothing the first run did not.
//     Nothing here inserts a container, a deployment, or a domain.
//   - Non-destructive. It writes status corrections only. No deployment row, log, or domain is deleted,
//     and no container is started, stopped, or removed.
//   - Bounded. Every observation is a single call with its own timeout, and the whole run has a deadline.
//     An observation that cannot complete becomes `unknown`, never a negative finding.
//   - Single-flight. A second concurrent run is refused rather than interleaved with the first.

import { prisma } from "@/lib/db";
import { containerRuntime, imageExists, portAvailable } from "@/lib/deployments/docker.ts";
import { openRemoteDeployment } from "@/lib/deployments/remote/server.ts";
import { remoteContainerRuntime, remoteDockerImageExists, remotePortOwner } from "@/lib/deployments/remote/docker.ts";
import { caddyContainerName, caddyReadConfigCommand } from "@/lib/deployments/remote/caddy.ts";
import { remoteCommand } from "@/lib/deployments/remote/args.ts";
import { canonicalArchitecture } from "@/lib/deployments/architecture.ts";
import { configHash, renderCaddyfile } from "@/lib/exposure/caddy.ts";
import { reconcileServer } from "@/lib/exposure/service.ts";
import type { SshTransport } from "@/lib/servers/ssh.ts";
import {
  classifyDeployment,
  classifyDomain,
  overallOutcome,
  type ContainerObservation,
  type DeploymentObservation,
  type DomainObservation,
  type ReconcileFinding,
  type ReconcileOutcome,
} from "./classify.ts";

export type ReconcileReport = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  outcome: ReconcileOutcome;
  /** Set when the run was refused or cut short. */
  error: { code: string; message: string } | null;
  counts: Record<ReconcileOutcome, number>;
  deploymentsInspected: number;
  serversInspected: number;
  domainsInspected: number;
  correctionsApplied: number;
  proxyReconciles: number;
  findings: (ReconcileFinding & { target: "local" | "remote"; hostname?: string })[];
  /** Actions that would have run, or did run. Never includes a destructive action. */
  actions: { deploymentId: string | null; hostname: string | null; kind: string; note: string; applied: boolean }[];
};

export class ReconcileError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
    this.status = status;
  }
}

/** One observation is never allowed to consume the whole run. */
const observationTimeoutMs = 20_000;
/** The whole run is bounded so a wedged dependency cannot hold the lock open indefinitely. */
const defaultRunBudgetMs = 240_000;

const emptyCounts = (): Record<ReconcileOutcome, number> => ({ healthy: 0, recovering: 0, stale: 0, unavailable: 0, unhealthy: 0, requires_attention: 0 });

/** Runs `work` under a deadline, resolving to `fallback` rather than hanging past the budget. */
function bounded<T>(work: Promise<T>, fallback: T, ms = observationTimeoutMs): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    // The losing promise still settles later; it must not surface as an unhandled rejection.
    work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

// -------------------------------------------------------------------------------------------
// Single-flight
// -------------------------------------------------------------------------------------------

let activeRun: Promise<ReconcileReport> | null = null;

/** True while a reconciliation is in progress, for the UI and the scheduler. */
export function reconciliationInProgress() {
  return activeRun !== null;
}

/**
 * Runs reconciliation, or returns the run already in progress.
 *
 * Two overlapping runs would observe the same state and both write corrections, which is exactly the kind
 * of double-application this whole phase exists to prevent. `waitForActive: false` refuses instead.
 */
export function reconcile(options: { userId?: string; dryRun?: boolean; budgetMs?: number; waitForActive?: boolean } = {}): Promise<ReconcileReport> {
  if (activeRun) {
    if (options.waitForActive === false) throw new ReconcileError("reconcile_in_progress", "A reconciliation is already running.", 409);
    return activeRun;
  }
  const run = runReconcile(options).finally(() => { activeRun = null; });
  activeRun = run;
  return run;
}

// -------------------------------------------------------------------------------------------
// Observations
// -------------------------------------------------------------------------------------------

/** The deployment rows worth reconciling: anything live, plus anything with a container or image claim. */
async function loadDeployments(userId?: string) {
  return prisma.deployment.findMany({
    where: {
      ...(userId ? { project: { userId } } : {}),
      OR: [
        { status: { in: ["pending", "building", "starting", "running", "unhealthy", "stopping"] } },
        { containerName: { not: null } },
      ],
    },
    orderBy: { createdAt: "asc" },
    include: {
      environment: { select: { hostPort: true, containerPort: true, healthPath: true, healthTimeoutMs: true, healthRetries: true, target: true, serverId: true } },
      server: { select: { id: true, status: true, architecture: true } },
      // The owner, needed to open the server's SSH session on that owner's behalf.
      project: { select: { userId: true } },
    },
  });
}

/** A local deployment's runtime truth, with every uncertain answer reported as unknown. */
async function observeLocal(deployment: { containerId: string | null; imageTag: string | null; environment: { hostPort: number; healthPath: string; healthTimeoutMs: number; healthRetries: number } }): Promise<Pick<DeploymentObservation, "containerObserved" | "imagePresent" | "healthObserved" | "portHeldByForeignContainer">> {
  const containerObserved = await bounded(
    deployment.containerId
      ? containerRuntime(deployment.containerId).then((runtime): ContainerObservation => (runtime ? (runtime.running ? "running" : "stopped") : "absent"))
      : Promise.resolve<ContainerObservation>("absent"),
    "unknown",
  );
  const imagePresent = await bounded(deployment.imageTag ? imageExists(deployment.imageTag) : Promise.resolve(null), null);
  // A single quick request, not the deployment's full retry schedule: this is an observation, not a gate.
  const healthObserved = await bounded(
    (async () => {
      const { healthCheck } = await import("@/lib/deployments/docker.ts");
      const result = await healthCheck(deployment.environment.hostPort, deployment.environment.healthPath, Math.min(deployment.environment.healthTimeoutMs, 5_000), 1);
      if (result.healthy) return "healthy" as const;
      return result.transportError ? ("unreachable" as const) : ("unhealthy" as const);
    })(),
    "unknown" as const,
  );
  const portHeldByForeignContainer = await bounded(healthObserved === "healthy" ? Promise.resolve(false) : portAvailable(deployment.environment.hostPort).then((free) => !free), false);
  return { containerObserved, imagePresent, healthObserved, portHeldByForeignContainer };
}

/** A remote deployment's runtime truth over the existing pinned SSH transport. */
async function observeRemote(
  transport: SshTransport,
  deployment: { containerName: string | null; imageTag: string | null; environment: { hostPort: number; healthPath: string; healthTimeoutMs: number; healthRetries: number } },
): Promise<Pick<DeploymentObservation, "containerObserved" | "imagePresent" | "healthObserved" | "portHeldByForeignContainer">> {
  const containerObserved = await bounded(
    deployment.containerName
      ? remoteContainerRuntime(transport, deployment.containerName).then((runtime): ContainerObservation => (runtime ? (runtime.running ? "running" : "stopped") : "absent"))
      : Promise.resolve<ContainerObservation>("absent"),
    "unknown",
  );
  const imagePresent = await bounded(deployment.imageTag ? remoteDockerImageExists(transport, deployment.imageTag) : Promise.resolve(null), null);
  const healthObserved = await bounded(
    (async () => {
      const { remoteHealthCheck } = await import("@/lib/deployments/remote/docker.ts");
      const result = await remoteHealthCheck(transport, deployment.environment.hostPort, deployment.environment.healthPath, 1, Math.min(deployment.environment.healthTimeoutMs, 5_000));
      if (result.healthy) return "healthy" as const;
      return result.transportError ? ("unreachable" as const) : ("unhealthy" as const);
    })(),
    "unknown" as const,
  );
  const portHeldByForeignContainer = await bounded(healthObserved === "healthy" ? Promise.resolve(false) : remotePortOwner(transport, deployment.environment.hostPort).then((owner) => Boolean(owner)), false);
  return { containerObserved, imagePresent, healthObserved, portHeldByForeignContainer };
}

// -------------------------------------------------------------------------------------------
// The run
// -------------------------------------------------------------------------------------------

async function runReconcile(options: { userId?: string; dryRun?: boolean; budgetMs?: number }): Promise<ReconcileReport> {
  const startedAt = new Date();
  const deadline = startedAt.getTime() + (options.budgetMs ?? defaultRunBudgetMs);
  const dryRun = options.dryRun === true;

  const report: ReconcileReport = {
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    dryRun,
    outcome: "healthy",
    error: null,
    counts: emptyCounts(),
    deploymentsInspected: 0,
    serversInspected: 0,
    domainsInspected: 0,
    correctionsApplied: 0,
    proxyReconciles: 0,
    findings: [],
    actions: [],
  };

  const remaining = () => Math.max(0, deadline - Date.now());

  try {
    // A database outage is a dependency failure, not a finding about deployments. It is reported as such
    // and nothing is concluded.
    const deployments = await prisma.deployment.findMany({ where: { id: "__reconcile_probe__" }, select: { id: true } }).then(() => loadDeployments(options.userId));

    // Grouped by server so one SSH session covers every deployment on that host.
    const byServer = new Map<string, typeof deployments>();
    const local = [] as typeof deployments;
    for (const deployment of deployments) {
      if (deployment.environment.target === "remote" && deployment.server?.id) {
        const list = byServer.get(deployment.server.id) ?? [];
        list.push(deployment);
        byServer.set(deployment.server.id, list);
      } else {
        local.push(deployment);
      }
    }

    // ---- local ---------------------------------------------------------------------------
    for (const deployment of local) {
      if (remaining() <= 0) throw new ReconcileError("reconcile_budget_exceeded", "Reconciliation ran out of time before it finished.", 503);
      const observed = await observeLocal(deployment);
      const finding = classifyDeployment({
        deploymentId: deployment.id,
        recordedStatus: deployment.status,
        recordedHealth: deployment.healthStatus,
        lastStage: deployment.lastStage,
        containerId: deployment.containerId,
        containerName: deployment.containerName,
        imageTag: deployment.imageTag,
        target: "local",
        serverId: null,
        serverReachable: true,
        serverArchitecture: null,
        operationInterrupted: isInterrupted(deployment.status, deployment.lastStage),
        ...observed,
      });
      await applyDeploymentFinding(report, finding, "local", dryRun);
    }

    // ---- remote --------------------------------------------------------------------------
    for (const [serverId, serverDeployments] of byServer) {
      if (remaining() <= 0) throw new ReconcileError("reconcile_budget_exceeded", "Reconciliation ran out of time before it finished.", 503);
      report.serversInspected += 1;
      const first = serverDeployments[0];
      const userId = first.project.userId;

      // One session per server. A server we cannot reach yields `unavailable` for all of its
      // deployments and leaves their records untouched.
      type OpenResult = { context: Awaited<ReturnType<typeof openRemoteDeployment>> | null; reachable: boolean };
      const context = await bounded<OpenResult>(
        openRemoteDeployment(userId, serverId).then((context): OpenResult => ({ context, reachable: true })),
        { context: null, reachable: false },
      );
      const serverArchitecture = canonicalArchitecture(first.server?.architecture);

      for (const deployment of serverDeployments) {
        const observed = context.reachable && context.context
          ? await observeRemote(context.context.transport, deployment)
          : { containerObserved: "unknown" as const, imagePresent: null, healthObserved: "unknown" as const, portHeldByForeignContainer: false };

        const finding = classifyDeployment({
          deploymentId: deployment.id,
          recordedStatus: deployment.status,
          recordedHealth: deployment.healthStatus,
          lastStage: deployment.lastStage,
          containerId: deployment.containerId,
          containerName: deployment.containerName,
          imageTag: deployment.imageTag,
          target: "remote",
          serverId,
          serverReachable: context.reachable,
          serverArchitecture,
          operationInterrupted: isInterrupted(deployment.status, deployment.lastStage),
          ...observed,
        });

        // An incompatible architecture is reported rather than repaired. The image cannot run there and
        // no status change would make that true.
        if (serverArchitecture && deployment.imageTag) {
          const imageArchitecture = await bounded(dockerImageArchitecture(deployment.imageTag), null);
          const comparison = imageArchitecture ? { compatible: canonicalArchitecture(imageArchitecture) === serverArchitecture } : null;
          if (comparison && !comparison.compatible) {
            finding.outcome = "requires_attention";
            finding.code = "architecture_incompatible";
            finding.summary = `This deployment's image is ${canonicalArchitecture(imageArchitecture)} and its server is ${serverArchitecture}. It cannot run there.`;
            finding.actions = [{ kind: "report", note: "Image architecture is incompatible with the registered server." }];
          }
        }

        await applyDeploymentFinding(report, finding, "remote", dryRun);
      }

      if (context.context) await context.context.transport.close().catch(() => undefined);
    }

    // ---- domains and the reverse proxy ----------------------------------------------------
    await reconcileExposure(report, options.userId, dryRun, remaining);
  } catch (error) {
    const failure = error as { code?: string; message?: string; status?: number };
    report.error = {
      code: failure.code ?? "reconcile_failed",
      // The message is ours in every path except an unexpected driver error, which is not surfaced
      // verbatim because it can carry a connection string.
      message: failure.code && failure.message ? failure.message : "Reconciliation could not complete.",
    };
    report.outcome = "requires_attention";
  }

  report.counts = emptyCounts();
  for (const finding of report.findings) report.counts[finding.outcome] += 1;
  if (report.error) report.counts.requires_attention += 1;
  report.outcome = overallOutcome(report.findings);
  if (report.error) report.outcome = "requires_attention";
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  return report;
}

/**
 * A record left mid-flight by a restart or a daemon shutdown.
 *
 * `building` and `starting` are the stages where a process can vanish. A record sitting there long after
 * the operation ended is drift, not progress.
 */
function isInterrupted(status: string, lastStage: string | null) {
  return status === "building" || status === "starting" || lastStage === "stopping" || lastStage === "starting";
}

async function dockerImageArchitecture(tag: string): Promise<string | null> {
  const { imageArchitecture } = await import("@/lib/deployments/docker.ts");
  return imageArchitecture(tag);
}

/** Records a finding and, unless this is a dry run, applies its status correction. */
async function applyDeploymentFinding(
  report: ReconcileReport,
  finding: ReconcileFinding,
  target: "local" | "remote",
  dryRun: boolean,
) {
  report.deploymentsInspected += 1;
  report.findings.push({ ...finding, target });

  for (const action of finding.actions) {
    report.actions.push({ deploymentId: finding.deploymentId, hostname: null, kind: action.kind, note: action.note, applied: false });
    if (action.kind !== "update_status") continue;
    if (dryRun) continue;
    const applied = await prisma.deployment.update({ where: { id: finding.deploymentId }, data: { status: action.status as never, healthStatus: action.healthStatus as never } }).then(() => true, () => false);
    if (applied) {
      report.correctionsApplied += 1;
      report.actions[report.actions.length - 1].applied = true;
    }
  }
}

/**
 * Domain and proxy reconciliation.
 *
 * Drift is detected by comparing the configuration Caddy is actually running against the configuration
 * the recorded domains describe. Both are read from stored state; nothing outside Developer OS's own file
 * is rewritten, and a domain is never deleted.
 */
async function reconcileExposure(report: ReconcileReport, userId: string | undefined, dryRun: boolean, remaining: () => number) {
  const domains = await prisma.deploymentDomain.findMany({
    where: userId ? { server: { userId } } : undefined,
    include: { deployment: { include: { environment: { select: { hostPort: true } } } } },
  });
  if (!domains.length) return;
  report.domainsInspected = domains.length;

  const byServer = new Map<string, typeof domains>();
  for (const domain of domains) {
    const list = byServer.get(domain.serverId) ?? [];
    list.push(domain);
    byServer.set(domain.serverId, list);
  }

  for (const [serverId, serverDomains] of byServer) {
    if (remaining() <= 0) return;

    // The configuration the recorded domains currently describe.
    const desired = renderCaddyfile(serverDomains
      .filter((domain) => domain.status !== "disabled")
      .map((domain) => ({ hostname: domain.hostname, upstreamPort: domain.deployment.environment.hostPort, tlsEnabled: domain.tlsEnabled, tlsMode: domain.tlsMode, deploymentId: domain.deploymentId })));
    const desiredHash = configHash(desired);

    // The configuration the proxy is actually running, read back over SSH when it can be reached.
    let appliedHash: string | null = null;
    let proxyRunning: boolean | null = null;
    const server = await prisma.server.findFirst({ where: { id: serverId }, select: { userId: true } });
    if (server) {
      type ProxyOpen = { value: Awaited<ReturnType<typeof openRemoteDeployment>> | null; ok: boolean };
      const context = await bounded<ProxyOpen>(
        openRemoteDeployment(server.userId, serverId).then((value): ProxyOpen => ({ value, ok: true })),
        { value: null, ok: false },
      );
      if (context.ok && context.value) {
        try {
          const name = caddyContainerName(serverId);
          const listed = await context.value.transport.run(remoteCommand("docker", "ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"));
          proxyRunning = listed.stdout.split("\n").map((line) => line.trim()).includes(name);
          if (proxyRunning) {
            const read = await context.value.transport.run(caddyReadConfigCommand(name)).catch(() => null);
            appliedHash = read ? configHash(read.stdout) : null;
          }
        } finally {
          await context.value.transport.close().catch(() => undefined);
        }
      }
    }

    const wantsProxy = serverDomains.some((domain) => domain.status !== "disabled");

    for (const domain of serverDomains) {
      const serving = ["running", "unhealthy"].includes(domain.deployment.status);
      const routedInConfiguration = proxyRunning === null ? null : appliedHash !== null ? appliedHash === desiredHash : false;
      const observation: DomainObservation = {
        domainId: domain.id,
        hostname: domain.hostname,
        serverId,
        domainStatus: domain.status,
        upstreamServing: serving,
        routedInConfiguration,
        // A missing proxy while domains exist is drift in its own right.
        proxyRunning: wantsProxy ? proxyRunning !== true : null,
      };
      const finding = classifyDomain(observation);

      // Drift is fixed by regenerating from the stored domains, which is exactly what the exposure
      // service does. That keeps the domain records intact and never touches unrelated configuration.
      if (finding.code === "proxy_configuration_drift" && !dryRun) {
        const result = await reconcileServer(serverId).then((value) => ({ ok: true, value })).catch(() => ({ ok: false, value: null }));
        if (result.ok) {
          report.proxyReconciles += 1;
          for (const action of finding.actions) {
            if (action.kind === "report") continue;
            report.actions.push({ deploymentId: null, hostname: domain.hostname, kind: action.kind, note: action.note, applied: true });
          }
        }
      } else if (finding.code === "domain_upstream_not_serving" && !dryRun) {
        // The upstream is gone: withdraw the route but keep the record, and re-derive it when the
        // environment serves again.
        await reconcileServer(serverId).catch(() => undefined);
        await prisma.deploymentDomain.update({ where: { id: domain.id }, data: { status: "disabled", statusCode: "deployment_not_serving", statusMessage: "No deployment on this environment is serving.", lastCheckedAt: new Date() } }).catch(() => undefined);
        report.proxyReconciles += 1;
        report.actions.push({ deploymentId: null, hostname: domain.hostname, kind: "reconcile_proxy", note: "Withdrew an unhealthy hostname; the domain record was kept.", applied: true });
      } else if (finding.code === "domain_record_behind_runtime" && !dryRun) {
        await prisma.deploymentDomain.update({ where: { id: domain.id }, data: { status: "active", lastCheckedAt: new Date() } }).catch(() => undefined);
        report.correctionsApplied += 1;
      } else {
        for (const action of finding.actions) report.actions.push({ deploymentId: null, hostname: domain.hostname, kind: action.kind, note: action.note, applied: false });
      }

      report.findings.push({ ...finding, target: "remote", hostname: domain.hostname });
    }
  }
}