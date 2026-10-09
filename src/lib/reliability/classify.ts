// Deployment state reconciliation: the rules.
//
// Pure decision logic, no database and no Docker. `service.ts` gathers observations from the real
// runtime and applies the actions this module decides on. Keeping the rules here means the outcomes can
// be exercised directly rather than inferred from a source search.
//
// The governing idea: the database records what was *intended*; Docker and the network record what is
// *actually* true. Reconciliation compares the two and, where the difference is safe and unambiguous,
// records the truth. Where it is not safe, it says so instead of guessing.
//
// Two rules hold throughout:
//
//   - An observation that could not be made (`unknown`, a timeout, an unreachable host) is never treated
//     as a negative finding. "We could not check" must not become "the container is gone", because acting
//     on that would stop a healthy deployment over a failed API call.
//   - Nothing here deletes. The only writes are status corrections and status reverts to a terminal value.
//     Deployment history and logs are evidence and are never removed.

export const reconcileOutcomes = ["healthy", "recovering", "stale", "unavailable", "unhealthy", "requires_attention"] as const;
export type ReconcileOutcome = (typeof reconcileOutcomes)[number];

/** What the runtime actually looks like right now. `unknown` always means "could not determine". */
export type ContainerObservation = "running" | "stopped" | "absent" | "unknown";

/** What an actual HTTP request to the deployment returned. Distinct from Docker's own HEALTHCHECK. */
export type HealthObservation = "healthy" | "unhealthy" | "unreachable" | "unknown";

export type DeploymentObservation = {
  deploymentId: string;
  /** The status persisted in the database. */
  recordedStatus: string;
  recordedHealth: string | null;
  lastStage: string | null;
  containerId: string | null;
  containerName: string | null;
  imageTag: string | null;
  target: "local" | "remote";
  serverId: string | null;
  /** Whether the remote host answered at all. Only meaningful for a remote target. */
  serverReachable: boolean;
  /** The architecture the server record claims, for the compatibility check. */
  serverArchitecture: string | null;
  containerObserved: ContainerObservation;
  imagePresent: boolean | null;
  healthObserved: HealthObservation;
  /** The operation was cut short, e.g. the daemon restarted mid-restart. */
  operationInterrupted: boolean;
  /** The host port is held by a container Developer OS does not own. */
  portHeldByForeignContainer: boolean;
};

export type ReconcileAction =
  /** Correct the persisted status to match the runtime. */
  | { kind: "update_status"; status: string; healthStatus: string | null; note: string }
  /** The runtime is fine and the record is behind; bring the record forward. */
  | { kind: "update_status"; status: string; healthStatus: string | null; note: string }
  /** The proxy no longer reflects the desired domain set. Regenerate it. */
  | { kind: "reconcile_proxy"; serverId: string; note: string }
  /** Recorded for the operator. Never executed automatically. */
  | { kind: "report"; note: string };

export type ReconcileFinding = {
  deploymentId: string;
  outcome: ReconcileOutcome;
  code: string;
  summary: string;
  actions: ReconcileAction[];
};

const liveStatuses = ["running", "unhealthy", "starting", "building", "pending", "stopping"];
const terminalStatuses = ["stopped", "failed", "rolled_back"];

function isLive(status: string) {
  return liveStatuses.includes(status);
}

/**
 * Classifies one deployment against what is actually observed.
 *
 * Order matters. A host we could not reach is decided before anything about the container, because an
 * unreachable host makes every container observation unreliable and acting on it would be guessing.
 */
export function classifyDeployment(observation: DeploymentObservation): ReconcileFinding {
  const base = { deploymentId: observation.deploymentId };

  // ---------------------------------------------------------------------------------------------
  // The dependency is unavailable. Preserve the last known state and report the observation as
  // unavailable rather than declaring a remote container failure we cannot substantiate.
  // ---------------------------------------------------------------------------------------------
  if (observation.target === "remote" && !observation.serverReachable) {
    return {
      ...base,
      outcome: "unavailable",
      code: "remote_unreachable",
      summary: `${observation.containerName ?? "the container"} could not be observed because the remote server did not answer. Last recorded state: ${observation.recordedStatus}.`,
      // No action. The record is left exactly as it was.
      actions: [],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // A port held by something Developer OS does not own is never ours to act on.
  // ---------------------------------------------------------------------------------------------
  if (observation.portHeldByForeignContainer && isLive(observation.recordedStatus)) {
    return {
      ...base,
      outcome: "requires_attention",
      code: "host_port_held_by_foreign_container",
      summary: `Host port for ${observation.containerName ?? "this deployment"} is held by a container Developer OS does not own. It was left strictly alone.`,
      actions: [{ kind: "report", note: "A foreign container holds this deployment's host port." }],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The record claims it is live but there is no container.
  // ---------------------------------------------------------------------------------------------
  if (observation.containerObserved === "absent") {
    if (!isLive(observation.recordedStatus)) {
      // Consistent: a terminal record with no container is exactly right.
      return { ...base, outcome: "healthy", code: "terminal_without_container", summary: `${observation.containerName ?? "This deployment"} is ${observation.recordedStatus} and its container is absent, which is consistent.`, actions: [] };
    }
    if (observation.operationInterrupted) {
      // The daemon went away mid-operation. The right answer is to report, not to assume a clean stop.
      return {
        ...base,
        outcome: "recovering",
        code: "container_lost_during_operation",
        summary: `${observation.containerName ?? "The container"} is recorded ${observation.recordedStatus} but no longer exists, and an operation was interrupted. The record was corrected; the deployment was not re-run.`,
        actions: [{ kind: "update_status", status: "failed", healthStatus: "unhealthy", note: "Container disappeared during an interrupted operation. Deploy again to recover." }],
      };
    }
    return {
      ...base,
      outcome: "stale",
      code: "record_running_container_absent",
      summary: `${observation.containerName ?? "The container"} is recorded ${observation.recordedStatus} but does not exist. The record was corrected; nothing was started automatically.`,
      actions: [{ kind: "update_status", status: "stopped", healthStatus: "stopped", note: "Container is absent; recorded status corrected from " + observation.recordedStatus + "." }],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The container exists but is not running.
  // ---------------------------------------------------------------------------------------------
  if (observation.containerObserved === "stopped") {
    if (observation.recordedStatus === "stopped" || terminalStatuses.includes(observation.recordedStatus)) {
      return { ...base, outcome: "healthy", code: "stopped_consistently", summary: `${observation.containerName ?? "The container"} is stopped and the record says ${observation.recordedStatus}.`, actions: [] };
    }
    if (observation.operationInterrupted) {
      return {
        ...base,
        outcome: "recovering",
        code: "stopped_during_operation",
        summary: `${observation.containerName ?? "The container"} is stopped while the record says ${observation.recordedStatus}, after an interrupted operation. The record was corrected.`,
        actions: [{ kind: "update_status", status: "failed", healthStatus: "unhealthy", note: "Container stopped during an interrupted operation." }],
      };
    }
    return {
      ...base,
      outcome: "stale",
      code: "record_running_container_stopped",
      summary: `${observation.containerName ?? "The container"} is recorded ${observation.recordedStatus} but is stopped. The record was corrected; it was not restarted automatically.`,
      actions: [{ kind: "update_status", status: "stopped", healthStatus: "stopped", note: "Container is stopped; recorded status corrected from " + observation.recordedStatus + "." }],
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The container is running. Now compare the health signals, which are genuinely different things.
  // ---------------------------------------------------------------------------------------------
  if (observation.containerObserved === "running") {
    // The image the record depends on has gone. A running container is not evidence the deployment is
    // reproducible, and a rollback to that image would fail.
    if (observation.imagePresent === false && observation.imageTag) {
      return {
        ...base,
        outcome: "requires_attention",
        code: "image_unavailable",
        summary: `${observation.containerName ?? "The container"} is running, but its image ${observation.imageTag} is no longer present on the host. Rollback to this deployment is no longer possible.`,
        actions: [{ kind: "report", note: `Image ${observation.imageTag} is missing, so this deployment cannot be rolled back to.` }],
      };
    }

    if (observation.healthObserved === "unhealthy" || observation.healthObserved === "unreachable") {
      // A real HTTP request was attempted and the application did not answer. That is the application's
      // own signal and outranks the recorded value.
      //
      // `unreachable` is distinct from `unknown` on purpose. Unreachable means a request was made and
      // nothing answered - a connection refused or a timeout. Unknown means the check could not be
      // performed at all. The first is evidence about the application; the second is evidence about us,
      // and must never be turned into a verdict on the deployment.
      const code = observation.healthObserved === "unreachable" ? "http_unreachable" : "http_health_failing";
      const summary = observation.healthObserved === "unreachable"
        ? `${observation.containerName ?? "The container"} is running but nothing answered an HTTP request to it.`
        : `${observation.containerName ?? "The container"} is running but an HTTP request to it did not succeed.`;
      return {
        ...base,
        outcome: "unhealthy",
        code,
        summary,
        actions: [{ kind: "update_status", status: "unhealthy", healthStatus: "unhealthy", note: observation.healthObserved === "unreachable" ? "Nothing answered an HTTP request to the published port." : "HTTP health check is failing." }],
      };
    }

    if (observation.healthObserved === "unknown") {
      // The request could not complete. That is not evidence of failure.
      if (isLive(observation.recordedStatus)) {
        return { ...base, outcome: "unavailable", code: "health_unreachable", summary: `${observation.containerName ?? "The container"} is running but its health could not be determined. The record was left unchanged.`, actions: [] };
      }
      return {
        ...base,
        outcome: "stale",
        code: "container_running_record_terminal",
        summary: `${observation.containerName ?? "The container"} is running while the record says ${observation.recordedStatus}. The record was corrected to match.`,
        actions: [{ kind: "update_status", status: "running", healthStatus: observation.recordedHealth, note: `A container is running; recorded status ${observation.recordedStatus} corrected.` }],
      };
    }

    // Healthy over HTTP and the container is up.
    if (observation.recordedStatus !== "running") {
      return {
        ...base,
        outcome: "stale",
        code: "record_behind_runtime",
        summary: `${observation.containerName ?? "The container"} is running and healthy while the record says ${observation.recordedStatus}. The record was corrected.`,
        actions: [{ kind: "update_status", status: "running", healthStatus: "healthy", note: `Runtime is healthy; recorded status ${observation.recordedStatus} corrected.` }],
      };
    }
    if (observation.recordedHealth !== "healthy") {
      return {
        ...base,
        outcome: "stale",
        code: "health_record_behind_runtime",
        summary: `${observation.containerName ?? "The container"} is healthy while the record says health ${observation.recordedHealth}. The record was corrected.`,
        actions: [{ kind: "update_status", status: "running", healthStatus: "healthy", note: `HTTP health check passes; recorded health ${observation.recordedHealth} corrected.` }],
      };
    }
    return { ...base, outcome: "healthy", code: "consistent", summary: `${observation.containerName ?? "The deployment"} is running and answering, and the record agrees.`, actions: [] };
  }

  // ---------------------------------------------------------------------------------------------
  // The container could not be inspected at all.
  // ---------------------------------------------------------------------------------------------
  return {
    ...base,
    outcome: "unavailable",
    code: "container_unobservable",
    summary: `${observation.containerName ?? "The container"} could not be inspected. The record was left unchanged.`,
    actions: [],
  };
}

// -------------------------------------------------------------------------------------------
// Domains and the reverse proxy
// -------------------------------------------------------------------------------------------

export type DomainObservation = {
  domainId: string;
  hostname: string;
  /** The server whose proxy carries this hostname, so the action names where to apply it. */
  serverId: string;
  domainStatus: string;
  /** Whether anything on the environment is serving. */
  upstreamServing: boolean;
  /** Whether the running Caddy configuration carries this hostname. */
  routedInConfiguration: boolean | null;
  /** True when a Caddy container exists on the server. */
  proxyRunning: boolean | null;
};

/**
 * A domain is never removed for being unhealthy. The association is the operator's stated intent, and
 * the upstream is likely to come back. What changes is the reported status.
 */
export function classifyDomain(observation: DomainObservation): ReconcileFinding & { domainId: string; hostname: string } {
  const base = { deploymentId: "", domainId: observation.domainId, hostname: observation.hostname };

  // Nothing is serving: withdraw the route but keep the domain record.
  if (!observation.upstreamServing && observation.domainStatus !== "disabled") {
    return {
      ...base,
      outcome: "unhealthy",
      code: "domain_upstream_not_serving",
      summary: `${observation.hostname} has no serving upstream. The hostname was withdrawn from the proxy and kept as a record.`,
      actions: [{ kind: "reconcile_proxy", serverId: observation.serverId, note: `Withdraw ${observation.hostname}: nothing is serving.` }, { kind: "report", note: `Domain ${observation.hostname} has no serving upstream.` }],
    };
  }

  // Serving, but the running proxy configuration does not carry this hostname. The desired state and
  // the applied state have diverged, which is fixable by regenerating.
  if (observation.routedInConfiguration === false) {
    return {
      ...base,
      outcome: "stale",
      code: "proxy_configuration_drift",
      summary: `${observation.hostname} is serving but is absent from the running reverse proxy configuration. The configuration was regenerated from the recorded domains.`,
      actions: [{ kind: "reconcile_proxy", serverId: observation.serverId, note: `Restore ${observation.hostname} to the proxy configuration.` }],
    };
  }

  // Serving, routed, and healthy.
  if (observation.domainStatus !== "active" && observation.domainStatus !== "disabled") {
    return {
      ...base,
      outcome: "stale",
      code: "domain_record_behind_runtime",
      summary: `${observation.hostname} is routed and serving while the record says ${observation.domainStatus}. The record was corrected.`,
      actions: [{ kind: "update_status", status: "active", healthStatus: null, note: `Domain ${observation.hostname} is serving; recorded status corrected.` }],
    };
  }

  return { ...base, outcome: "healthy", code: "domain_consistent", summary: `${observation.hostname} is routed and serving, and the record agrees.`, actions: [] };
}

/**
 * The overall result for a reconciliation run.
 *
 * `healthy` only when nothing at all needed attention. The worst outcome wins, ordered by how much
 * operator involvement it implies.
 */
export function overallOutcome(findings: readonly { outcome: ReconcileOutcome }[]): ReconcileOutcome {
  if (!findings.length) return "healthy";
  const rank: Record<ReconcileOutcome, number> = {
    healthy: 0, stale: 1, recovering: 2, unhealthy: 3, unavailable: 4, requires_attention: 5,
  };
  return findings.reduce((worst, finding) => (rank[finding.outcome] > rank[worst] ? finding.outcome : worst), "healthy" as ReconcileOutcome);
}