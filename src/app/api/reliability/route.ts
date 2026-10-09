import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { deploymentIdentity, notAuthenticated, invalid } from "@/lib/deployments/api";
import { reconciliationInProgress, type ReconcileReport } from "@/lib/reliability/service.ts";
import { runReconciliationNow, schedulerState } from "@/lib/reliability/scheduler.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The summary the reliability panel renders.
 *
 * Every field is either a real measurement or a literal "unknown". Nothing here is derived from a
 * timestamp that might be stale, and no metric is invented when its source is unavailable.
 */
function summarize(report: ReconcileReport | null) {
  const scheduler = schedulerState();
  if (!report) {
    return {
      ran: false,
      outcome: "unknown",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      dryRun: null,
      error: null,
      counts: null,
      deploymentsInspected: 0,
      serversInspected: 0,
      domainsInspected: 0,
      correctionsApplied: 0,
      proxyReconciles: 0,
      inProgress: reconciliationInProgress(),
      schedulerEnabled: scheduler.started && !scheduler.blockedReason,
      schedulerBlockedReason: scheduler.blockedReason,
      skippedTicks: scheduler.skippedTicks,
      consecutiveFailures: scheduler.consecutiveFailures,
      findings: [],
      actions: [],
    };
  }
  return {
    ran: true,
    outcome: report.outcome,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    dryRun: report.dryRun,
    error: report.error,
    counts: report.counts,
    deploymentsInspected: report.deploymentsInspected,
    serversInspected: report.serversInspected,
    domainsInspected: report.domainsInspected,
    correctionsApplied: report.correctionsApplied,
    proxyReconciles: report.proxyReconciles,
    inProgress: reconciliationInProgress(),
    schedulerEnabled: scheduler.started && !scheduler.blockedReason,
    schedulerBlockedReason: scheduler.blockedReason,
    skippedTicks: scheduler.skippedTicks,
    consecutiveFailures: scheduler.consecutiveFailures,
    findings: report.findings,
    actions: report.actions,
  };
}

/** GET returns the last completed report. It never triggers a run, so polling it is free. */
export async function GET() {
  try {
    const identity = await deploymentIdentity();
    if (!identity) return notAuthenticated();
    const report = schedulerState().lastReport;
    return NextResponse.json(summarize(report));
  } catch (error) {
    return apiErrorResponse(error, { code: "reliability_unavailable", message: "Reliability status could not be read." });
  }
}

/**
 * POST runs a reconciliation on demand.
 *
 * `dryRun: true` reports what would happen without touching anything, which is the safe default for an
 * operator who has just come back to a system they did not watch. A concurrent run is refused with 409
 * rather than interleaved.
 */
export async function POST(request: Request) {
  try {
    const identity = await deploymentIdentity();
    if (!identity) return notAuthenticated();
    const body = await request.json().catch(() => null) as { dryRun?: unknown; action?: unknown } | null;
    if (body && typeof body.action === "string" && !["reconcile", "dry_run"].includes(body.action)) {
      return invalid("Action must be reconcile or dry_run.");
    }
    const dryRun = body?.dryRun === true || body?.action === "dry_run";
    const report = await runReconciliationNow({ dryRun });
    return NextResponse.json({ ...summarize(report), report });
  } catch (error) {
    const failure = error as { code?: string; message?: string; status?: number };
    if (failure.code === "reconcile_in_progress") {
      return NextResponse.json({ code: failure.code, message: failure.message }, { status: 409 });
    }
    return apiErrorResponse(error, { code: "reconcile_failed", message: "Reconciliation could not run." });
  }
}
