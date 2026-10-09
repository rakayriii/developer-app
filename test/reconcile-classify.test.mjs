import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDeployment, classifyDomain, overallOutcome, reconcileOutcomes } from "../src/lib/reliability/classify.ts";

/** A deployment that agrees with reality, overridden field by field. */
const observation = (overrides = {}) => ({
  deploymentId: "dep-1",
  recordedStatus: "running",
  recordedHealth: "healthy",
  lastStage: "health_check",
  containerId: "c1",
  containerName: "developer-os-gamevault-production-abc123",
  imageTag: "developer-os/gamevault:deployment-1",
  target: "local",
  serverId: null,
  serverReachable: true,
  serverArchitecture: null,
  containerObserved: "running",
  imagePresent: true,
  healthObserved: "healthy",
  operationInterrupted: false,
  portHeldByForeignContainer: false,
  ...overrides,
});

const only = (finding, kind) => finding.actions.filter((action) => action.kind === kind);

// -------------------------------------------------------------------------------------------
// The baseline
// -------------------------------------------------------------------------------------------
describe("a deployment that agrees with reality needs nothing", () => {
  it("reports healthy with no actions at all", () => {
    const finding = classifyDeployment(observation());
    assert.equal(finding.outcome, "healthy");
    assert.equal(finding.code, "consistent");
    assert.deepEqual(finding.actions, []);
  });

  it("accepts a terminal record with no container as consistent", () => {
    const finding = classifyDeployment(observation({ recordedStatus: "stopped", recordedHealth: "stopped", containerObserved: "absent", containerId: null }));
    assert.equal(finding.outcome, "healthy");
    assert.deepEqual(finding.actions, []);
  });

  it("accepts a stopped container matching a stopped record", () => {
    const finding = classifyDeployment(observation({ recordedStatus: "stopped", recordedHealth: "stopped", containerObserved: "stopped", healthObserved: "unknown" }));
    assert.equal(finding.outcome, "healthy");
    assert.deepEqual(finding.actions, []);
  });
});

// -------------------------------------------------------------------------------------------
// Stale records
// -------------------------------------------------------------------------------------------
describe("a record that disagrees with a reachable runtime is stale, and is corrected", () => {
  it("detects running in the database with no container", () => {
    const finding = classifyDeployment(observation({ containerObserved: "absent" }));
    assert.equal(finding.outcome, "stale");
    assert.equal(finding.code, "record_running_container_absent");
    const [update] = only(finding, "update_status");
    assert.equal(update.status, "stopped");
  });

  it("detects running in the database with a stopped container", () => {
    const finding = classifyDeployment(observation({ containerObserved: "stopped" }));
    assert.equal(finding.outcome, "stale");
    assert.equal(finding.code, "record_running_container_stopped");
    assert.equal(only(finding, "update_status")[0].status, "stopped");
  });

  it("detects a healthy container whose record says stopped", () => {
    const finding = classifyDeployment(observation({ recordedStatus: "stopped", recordedHealth: "stopped" }));
    assert.equal(finding.outcome, "stale");
    assert.equal(finding.code, "record_behind_runtime");
    assert.equal(only(finding, "update_status")[0].status, "running");
  });

  it("detects a healthy container whose record says the wrong health", () => {
    const finding = classifyDeployment(observation({ recordedHealth: "starting" }));
    assert.equal(finding.outcome, "stale");
    assert.equal(finding.code, "health_record_behind_runtime");
    const [update] = only(finding, "update_status");
    assert.equal(update.status, "running");
    assert.equal(update.healthStatus, "healthy");
  });

  it("never restarts or recreates anything while correcting a record", () => {
    // Reconciliation records what is true. Re-running a deployment is the operator's decision.
    for (const overrides of [{ containerObserved: "absent" }, { containerObserved: "stopped" }, { recordedStatus: "stopped", recordedHealth: "stopped" }]) {
      const finding = classifyDeployment(observation(overrides));
      for (const action of finding.actions) {
        assert.ok(["update_status", "reconcile_proxy", "report"].includes(action.kind), `unexpected action ${action.kind}`);
      }
      assert.equal(only(finding, "report").length, 0, "a routine correction should not demand attention");
    }
  });
});

// -------------------------------------------------------------------------------------------
// Unavailable is not the same as failed
// -------------------------------------------------------------------------------------------
describe("an observation that could not be made is never treated as a failure", () => {
  it("preserves the last known state when the remote server does not answer", () => {
    const finding = classifyDeployment(observation({ target: "remote", serverId: "srv-1", serverReachable: false, containerObserved: "unknown", healthObserved: "unknown" }));
    assert.equal(finding.outcome, "unavailable");
    assert.equal(finding.code, "remote_unreachable");
    // Nothing is written. Inventing a definitive remote container failure is exactly what this avoids.
    assert.deepEqual(finding.actions, []);
    assert.match(finding.summary, /Last recorded state: running/);
  });

  it("prefers unavailability over every other conclusion when the host is unreachable", () => {
    // Even with observations that would otherwise look like a missing container.
    const finding = classifyDeployment(observation({ target: "remote", serverId: "srv-1", serverReachable: false, containerObserved: "absent" }));
    assert.equal(finding.outcome, "unavailable");
    assert.deepEqual(finding.actions, []);
  });

  it("does not stop a healthy deployment because a health request timed out", () => {
    const finding = classifyDeployment(observation({ healthObserved: "unknown" }));
    assert.equal(finding.outcome, "unavailable");
    assert.equal(finding.code, "health_unreachable");
    assert.deepEqual(finding.actions, [], "a timed-out probe must not change a healthy record");
  });

  it("leaves the record alone when the container cannot be inspected", () => {
    const finding = classifyDeployment(observation({ containerObserved: "unknown", healthObserved: "unknown" }));
    assert.equal(finding.outcome, "unavailable");
    assert.equal(finding.code, "container_unobservable");
    assert.deepEqual(finding.actions, []);
  });
});

// -------------------------------------------------------------------------------------------
// Genuinely unhealthy
// -------------------------------------------------------------------------------------------
describe("a real HTTP failure is unhealthy, and outranks the recorded value", () => {
  it("reports unhealthy when the application does not answer", () => {
    const finding = classifyDeployment(observation({ healthObserved: "unhealthy" }));
    assert.equal(finding.outcome, "unhealthy");
    assert.equal(finding.code, "http_health_failing");
    assert.equal(only(finding, "update_status")[0].healthStatus, "unhealthy");
  });

  it("overrides a healthy recorded status with a failing application", () => {
    const finding = classifyDeployment(observation({ recordedStatus: "running", recordedHealth: "healthy", healthObserved: "unhealthy" }));
    assert.equal(finding.outcome, "unhealthy");
    assert.equal(only(finding, "update_status")[0].status, "unhealthy");
  });

  it("treats an unreachable application as unhealthy, never as healthy", () => {
    // A request was attempted and nothing answered. That is evidence about the application, not about
    // the probe, so it must never fall through to a healthy verdict.
    const finding = classifyDeployment(observation({ healthObserved: "unreachable" }));
    assert.equal(finding.outcome, "unhealthy");
    assert.equal(finding.code, "http_unreachable");
    assert.equal(only(finding, "update_status")[0].healthStatus, "unhealthy");
  });

  it("keeps an unperformable check as unavailable rather than a verdict", () => {
    // The mirror image: unknown means we could not check, so no conclusion is drawn.
    const finding = classifyDeployment(observation({ healthObserved: "unknown" }));
    assert.equal(finding.outcome, "unavailable");
    assert.deepEqual(finding.actions, []);
  });
});

// -------------------------------------------------------------------------------------------
// Interrupted operations
// -------------------------------------------------------------------------------------------
describe("an operation cut short is recovering, not silently stopped", () => {
  it("marks a lost container after an interrupted operation as recovering", () => {
    const finding = classifyDeployment(observation({ containerObserved: "absent", operationInterrupted: true }));
    assert.equal(finding.outcome, "recovering");
    assert.equal(finding.code, "container_lost_during_operation");
    // Recorded as failed so an operator can retry, and never silently as stopped.
    assert.equal(only(finding, "update_status")[0].status, "failed");
  });

  it("marks a stopped container after an interrupted operation as recovering", () => {
    const finding = classifyDeployment(observation({ containerObserved: "stopped", operationInterrupted: true }));
    assert.equal(finding.outcome, "recovering");
    assert.equal(finding.code, "stopped_during_operation");
  });

  it("ignores the interrupted flag when the record already agrees", () => {
    const finding = classifyDeployment(observation({ containerObserved: "running", healthObserved: "healthy", operationInterrupted: true }));
    assert.equal(finding.outcome, "healthy");
  });
});

// -------------------------------------------------------------------------------------------
// Things needing a human
// -------------------------------------------------------------------------------------------
describe("conditions reconciliation must not fix on its own", () => {
  it("reports a missing image without changing the status", () => {
    const finding = classifyDeployment(observation({ imagePresent: false }));
    assert.equal(finding.outcome, "requires_attention");
    assert.equal(finding.code, "image_unavailable");
    assert.equal(only(finding, "update_status").length, 0, "the deployment is still running; only the rollback path is lost");
    assert.equal(only(finding, "report").length, 1);
  });

  it("reports a foreign container holding the port, and never acts on it", () => {
    const finding = classifyDeployment(observation({ portHeldByForeignContainer: true }));
    assert.equal(finding.outcome, "requires_attention");
    assert.equal(finding.code, "host_port_held_by_foreign_container");
    assert.equal(only(finding, "report").length, 1);
    assert.match(finding.summary, /left strictly alone/);
  });

  it("does not demand attention for a missing image on a terminal record", () => {
    const finding = classifyDeployment(observation({ recordedStatus: "stopped", recordedHealth: "stopped", containerObserved: "absent", imagePresent: false }));
    assert.equal(finding.outcome, "healthy");
  });
});

// -------------------------------------------------------------------------------------------
// Domains and the proxy
// -------------------------------------------------------------------------------------------
describe("domains are preserved, never deleted, and drift is fixed", () => {
  const domain = (overrides = {}) => ({
    domainId: "dom-1",
    hostname: "gamevault.test",
    serverId: "srv-1",
    domainStatus: "active",
    upstreamServing: true,
    routedInConfiguration: true,
    proxyRunning: true,
    ...overrides,
  });

  it("reports a consistent domain as healthy", () => {
    const finding = classifyDomain(domain());
    assert.equal(finding.outcome, "healthy");
    assert.deepEqual(finding.actions, []);
  });

  it("detects configuration drift and asks for a regenerate", () => {
    const finding = classifyDomain(domain({ routedInConfiguration: false }));
    assert.equal(finding.outcome, "stale");
    assert.equal(finding.code, "proxy_configuration_drift");
    assert.equal(only(finding, "reconcile_proxy").length, 1);
  });

  it("withdraws the route when nothing is serving but keeps the domain record", () => {
    const finding = classifyDomain(domain({ upstreamServing: false }));
    assert.equal(finding.outcome, "unhealthy");
    assert.equal(only(finding, "reconcile_proxy").length, 1);
    assert.equal(only(finding, "reconcile_proxy")[0].serverId, "srv-1", "the action must name the server it applies to");
    assert.equal(only(finding, "report").length, 1);
    // There is no delete action anywhere in this module.
    assert.ok(!finding.actions.some((action) => /delete|remove/i.test(JSON.stringify(action))));
  });

  it("leaves an explicitly disabled domain alone even with no upstream", () => {
    const finding = classifyDomain(domain({ domainStatus: "disabled", upstreamServing: false }));
    assert.equal(finding.outcome, "healthy");
    assert.deepEqual(finding.actions, []);
  });

  it("does not conclude drift when the proxy could not be inspected", () => {
    const finding = classifyDomain(domain({ routedInConfiguration: null, proxyRunning: null }));
    assert.notEqual(finding.code, "proxy_configuration_drift");
  });

  it("corrects a domain record that lags a serving, routed hostname", () => {
    const finding = classifyDomain(domain({ domainStatus: "pending" }));
    assert.equal(finding.outcome, "stale");
    assert.equal(only(finding, "update_status")[0].status, "active");
  });
});

// -------------------------------------------------------------------------------------------
// Overall result
// -------------------------------------------------------------------------------------------
describe("the run reports the worst outcome it saw", () => {
  it("is healthy when nothing was found", () => {
    assert.equal(overallOutcome([]), "healthy");
  });

  it("is healthy when everything is healthy", () => {
    assert.equal(overallOutcome([{ outcome: "healthy" }, { outcome: "healthy" }]), "healthy");
  });

  it("escalates from stale up to requires_attention", () => {
    assert.equal(overallOutcome([{ outcome: "healthy" }, { outcome: "stale" }]), "stale");
    assert.equal(overallOutcome([{ outcome: "stale" }, { outcome: "unhealthy" }]), "unhealthy");
    assert.equal(overallOutcome([{ outcome: "unavailable" }, { outcome: "requires_attention" }]), "requires_attention");
    assert.equal(overallOutcome([{ outcome: "requires_attention" }, { outcome: "healthy" }]), "requires_attention");
  });

  it("uses only the documented outcome names", () => {
    for (const outcome of reconcileOutcomes) assert.equal(typeof outcome, "string");
    assert.deepEqual([...reconcileOutcomes].sort(), [...reconcileOutcomes].sort());
  });
});

// -------------------------------------------------------------------------------------------
// Safety invariants over the whole surface
// -------------------------------------------------------------------------------------------
describe("no reconciliation path is destructive", () => {
  const everyObservation = [
    {},
    { containerObserved: "absent" }, { containerObserved: "stopped" }, { containerObserved: "unknown" },
    { healthObserved: "unhealthy" }, { healthObserved: "unknown" }, { healthObserved: "unreachable" },
    { operationInterrupted: true }, { imagePresent: false }, { portHeldByForeignContainer: true },
    { target: "remote", serverId: "s", serverReachable: false },
    { recordedStatus: "stopped", recordedHealth: "stopped" },
    { recordedStatus: "failed", recordedHealth: "unhealthy" },
  ].map((overrides) => observation(overrides));

  it("never proposes starting, stopping, removing, or deploying anything", () => {
    for (const item of everyObservation) {
      const serialized = JSON.stringify(classifyDeployment(item).actions);
      for (const forbidden of ["start", "stop_container", "remove", "delete", "rebuild", "deploy", "restart"]) {
        assert.doesNotMatch(serialized, new RegExp(`"kind":"${forbidden}"`), `proposed ${forbidden}`);
      }
    }
  });

  it("only ever writes a status the lifecycle already defines", () => {
    const allowed = ["pending", "building", "starting", "running", "unhealthy", "stopping", "stopped", "failed", "rolled_back"];
    for (const item of everyObservation) {
      for (const action of classifyDeployment(item).actions) {
        if (action.kind !== "update_status") continue;
        assert.ok(allowed.includes(action.status), `${action.status} is not a real deployment status`);
      }
    }
  });

  it("produces no action at all when the deployment is healthy", () => {
    assert.deepEqual(classifyDeployment(observation()).actions, []);
  });
});