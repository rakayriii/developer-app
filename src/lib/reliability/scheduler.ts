// Startup and periodic reconciliation.
//
// One timer, created once, for the life of the process. There is deliberately no second polling loop
// anywhere: the UI asks the API for the last report rather than triggering work of its own.
//
// Three properties matter here:
//
//   - It never rebuilds. Reconciliation only corrects recorded state. A deployment that is legitimately
//     stopped stays stopped, and an absent container is not recreated on the operator's behalf.
//   - It waits for its dependencies. Reconciling against a database that is still starting produces a
//     report full of false findings, and reconciling against a Docker daemon that is not ready produces a
//     report full of `unknown`. Both would be worse than waiting.
//   - It cannot overlap itself. If a run is still going when the next tick arrives, the tick is skipped
//     rather than queued, so a slow remote host cannot build a backlog.

import { localDaemonArchitecture } from "@/lib/deployments/docker.ts";
import { reconcile, reconciliationInProgress, type ReconcileReport } from "./service.ts";
import { prisma } from "@/lib/db";

export type SchedulerState = {
  started: boolean;
  timerActive: boolean;
  lastReport: ReconcileReport | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  skippedTicks: number;
  consecutiveFailures: number;
  /** Why the scheduler is not running, when it is not. */
  blockedReason: string | null;
};

const state: SchedulerState = {
  started: false,
  timerActive: false,
  lastReport: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  skippedTicks: 0,
  consecutiveFailures: 0,
  blockedReason: null,
};

/** How often the scheduler runs. Startup reconciliation is once; this is the steady-state interval. */
const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS || 5 * 60 * 1000);
/** Reconciliation is skipped entirely unless explicitly enabled, because it touches Docker and SSH. */
const enabled = process.env.RECONCILE_ON_START !== "0";
/** Backoff after a failed run, so a broken dependency is not hammered every interval. */
const maxBackoffMs = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/**
 * Waits for the dependencies a reconciliation run needs.
 *
 * The database is required. Docker is preferred but not required: if it never becomes available the run
 * still happens and reports every local deployment as unobservable, which is more useful than silence.
 */
export async function waitForDependencies(timeoutMs = 60_000): Promise<{ database: boolean; docker: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  let database = false;
  let docker = false;
  let detail = "";

  while (Date.now() < deadline) {
    database = await prisma.deployment.count().then(() => true, () => false);
    if (!database) {
      detail = "Waiting for the database.";
      await delay(2000);
      continue;
    }
    const architecture = await localDaemonArchitecture();
    docker = Boolean(architecture);
    detail = docker ? "" : "The Docker daemon is not answering yet; local deployments will report as unobservable.";
    return { database, docker, detail };
  }
  return { database, docker, detail: detail || "Timed out waiting for dependencies." };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runOnce(): Promise<ReconcileReport | null> {
  if (reconciliationInProgress()) {
    state.skippedTicks += 1;
    return null;
  }
  state.lastStartedAt = new Date().toISOString();
  try {
    const report = await reconcile({});
    state.lastReport = report;
    state.consecutiveFailures = report.error ? state.consecutiveFailures + 1 : 0;
    return report;
  } catch (error) {
    // reconcile() itself does not throw for run failures, so this is an unexpected fault.
    state.consecutiveFailures += 1;
    state.blockedReason = error instanceof Error ? error.message : "Reconciliation failed unexpectedly.";
    return null;
  } finally {
    state.lastFinishedAt = new Date().toISOString();
  }
}

/**
 * Starts the scheduler. Safe to call more than once: a second call is a no-op.
 *
 * Returns immediately. The first run happens after the dependency wait, in the background, so it never
 * delays the HTTP listener coming up.
 */
export function startReconciliationScheduler(): SchedulerState {
  if (state.started) return state;
  state.started = true;
  if (!enabled) {
    state.blockedReason = "Startup reconciliation is disabled (RECONCILE_ON_START=0).";
    return state;
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    // Exponential backoff, capped, so an unreachable database or Docker daemon is not polled hard.
    const backoff = Math.min(intervalMs * 2 ** state.consecutiveFailures, maxBackoffMs);
    timer = setTimeout(() => { void tick(); schedule(); }, backoff);
    timer.unref?.();
    state.timerActive = true;
  };

  const tick = async () => {
    await waitForDependencies().catch(() => undefined);
    await runOnce();
  };

  // First run shortly after startup rather than immediately, so the app is serving before Docker and the
  // remote hosts are probed.
  timer = setTimeout(() => { void tick(); schedule(); }, 5_000);
  timer.unref?.();
  state.timerActive = true;
  return state;
}

/** Stops the scheduler. Used by tests and by a clean shutdown. */
export function stopReconciliationScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  state.timerActive = false;
}

export function schedulerState(): SchedulerState {
  return { ...state, lastReport: state.lastReport };
}

/** Runs reconciliation on demand, which is what the UI's refresh action calls. */
export async function runReconciliationNow(options: { dryRun?: boolean } = {}) {
  return reconcile({ ...options, waitForActive: true });
}