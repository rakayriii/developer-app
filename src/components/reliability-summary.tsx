"use client";

import { readApiJson } from "@/lib/api/client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

// A compact reliability summary: one list, not a wall of status cards.
//
// Every value shown is a real measurement or a literal "Unknown". Nothing is derived from a timestamp that
// may be stale, and no metric is invented when its source did not answer - a missing measurement reads as
// unknown rather than as good news.

type Finding = { deploymentId: string; outcome: string; code: string; summary: string; target: "local" | "remote"; hostname?: string };
type Action = { deploymentId: string | null; hostname: string | null; kind: string; note: string; applied: boolean };
type Backups = { directory: string; encryptionConfigured: boolean; backups: { id: string; fileName: string; createdAt: string; sizeBytes: number; sha256: string; encrypted: boolean; result: string; error: { code: string; message: string } | null }[] } | null;

export type ReliabilityReport = {
  ran: boolean;
  dependencies: { database: "ok" | "unavailable"; docker: "ok" | "unavailable" };
  outcome: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  dryRun: boolean | null;
  error: { code: string; message: string } | null;
  counts: Record<string, number> | null;
  deploymentsInspected: number;
  serversInspected: number;
  domainsInspected: number;
  correctionsApplied: number;
  proxyReconciles: number;
  inProgress: boolean;
  schedulerEnabled: boolean;
  schedulerBlockedReason: string | null;
  skippedTicks: number;
  consecutiveFailures: number;
  findings: Finding[];
  actions: Action[];
};

// Severity, used for the left-hand tone of a row. Derived from the outcome, never invented per row.
const tone: Record<string, string> = {
  healthy: "green",
  stale: "yellow",
  recovering: "yellow",
  unhealthy: "red",
  unavailable: "yellow",
  requires_attention: "red",
};

const outcomeLabel: Record<string, string> = {
  healthy: "Healthy", stale: "Stale", recovering: "Recovering", unhealthy: "Unhealthy",
  unavailable: "Unavailable", requires_attention: "Needs attention",
};

const ago = (value: string | null | undefined) => {
  if (!value) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

/**
 * A dependency's state, as measured by the run rather than inferred.
 *
 * "Unknown" when no run has happened, which is deliberately different from "reachable".
 */
function dependency(ran: boolean | undefined, value: "ok" | "unavailable" | undefined) {
  if (!ran) return "Unknown";
  if (value === "ok") return "Reachable";
  return "Unavailable";
}

const countBy = (findings: readonly Finding[], target: "local" | "remote") => findings.filter((finding) => finding.target === target).length;

/** The remediation that is safe to offer for each finding. Only corrections are automated. */
function remediation(finding: Finding) {
  if (finding.code === "record_running_container_absent" || finding.code === "record_running_container_stopped") {
    return finding.deploymentId ? <Link className="text-button" href={`/deployments/${finding.deploymentId}`}>Open deployment</Link> : null;
  }
  if (finding.code === "domain_upstream_not_serving" || finding.code === "proxy_configuration_drift") {
    return <Link className="text-button" href="/deployments">Open deployments</Link>;
  }
  if (finding.code === "architecture_incompatible") {
    return <Link className="text-button" href="/servers">Open servers</Link>;
  }
  if (finding.code === "host_port_held_by_foreign_container" || finding.code === "image_unavailable") {
    return <Link className="text-button" href="/deployments">Open deployments</Link>;
  }
  return null;
}

export default function ReliabilitySummary() {
  const [report, setReport] = useState<ReliabilityReport | null>(null);
  const [backups, setBackups] = useState<Backups>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [reliability, backupList] = await Promise.all([
        fetch("/api/reliability", { cache: "no-store" }),
        fetch("/api/backups", { cache: "no-store" }),
      ]);
      const reliabilityResult = await readApiJson<ReliabilityReport>(reliability);
      if (reliabilityResult.ok) setReport(reliabilityResult.data);
      else setError(reliabilityResult.error.message);
      const backupResult = await readApiJson<Backups>(backupList);
      if (backupResult.ok) setBackups(backupResult.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Reliability status could not be read.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    // Polls the already-computed report. It never triggers a run, so this is free.
    const interval = window.setInterval(() => void load(), 15000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [load]);

  const act = async (action: "reconcile" | "dry_run") => {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch("/api/reliability", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const result = await readApiJson<{ outcome: string; report: ReliabilityReport }>(response);
      if (!result.ok) throw new Error(result.error.message);
      setReport(result.data.report);
      setNotice(action === "dry_run"
        ? `Dry run complete: ${result.data.report.findings.length} finding(s). Nothing was changed.`
        : `Reconciliation complete: ${result.data.report.outcome}, ${result.data.report.correctionsApplied} correction(s).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The operation failed.");
    } finally {
      setBusy("");
    }
  };

  const backup = async () => {
    setBusy("backup"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/backups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
      const result = await readApiJson<{ backup: { sizeBytes: number; fileName: string } }>(response);
      if (!result.ok) throw new Error(result.error.message);
      setNotice(`Backup created: ${result.data.backup.fileName} (${(result.data.backup.sizeBytes / 1024 / 1024).toFixed(1)} MB).`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The backup failed.");
    } finally {
      setBusy("");
    }
  };

  const allFindings = report?.findings ?? [];
  const outstanding = allFindings.filter((finding) => finding.outcome !== "healthy");
  const lastBackup = backups?.backups?.find((entry) => entry.result === "ok") ?? null;

  return <section className="system-section reliability-section">
    <div className="system-section-header">
      <h2>Reliability</h2>
      <div className="reliability-actions">
        <button className="secondary-button" onClick={() => void act("dry_run")} disabled={Boolean(busy) || report?.inProgress}>Preview changes</button>
        <button className="secondary-button" onClick={() => void act("reconcile")} disabled={Boolean(busy) || report?.inProgress}>Reconcile now</button>
        <button className="secondary-button" onClick={() => void backup()} disabled={Boolean(busy)}>Back up now</button>
      </div>
    </div>

    {error && <div className="github-state github-error" role="alert"><strong>Reliability action failed</strong><span>{error}</span></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}

    <dl className="reliability-facts">
      <div><dt>Last check</dt><dd>{report?.ran ? ago(report.finishedAt) : "Never"}{report?.ran ? <small> · {outcomeLabel[report.outcome] ?? report.outcome}</small> : null}</dd></div>
      <div><dt>PostgreSQL</dt><dd>{dependency(report?.ran, report?.dependencies.database)}</dd></div>
      <div><dt>Docker</dt><dd>{dependency(report?.ran, report?.dependencies.docker)}</dd></div>
      <div><dt>Deployments</dt><dd>{report?.ran ? `${report.deploymentsInspected} checked · ${countBy(outstanding.concat(allFindings), "local")} local, ${countBy(outstanding.concat(allFindings), "remote")} remote` : "Unknown"}</dd></div>
      <div><dt>Hostnames</dt><dd>{report?.ran ? `${report.domainsInspected} routed · ${outstanding.filter((finding) => finding.hostname).length} needing attention` : "Unknown"}</dd></div>
      <div><dt>Scheduled</dt><dd>{report?.schedulerEnabled ? `Every interval${report.skippedTicks ? ` · ${report.skippedTicks} skipped` : ""}` : report?.schedulerBlockedReason || "Not scheduled"}</dd></div>
      <div><dt>Last backup</dt><dd>{lastBackup ? `${ago(lastBackup.createdAt)} · ${(lastBackup.sizeBytes / 1024 / 1024).toFixed(1)} MB${lastBackup.encrypted ? " · encrypted" : ""}` : "Never"}</dd></div>
    </dl>

    {!report?.ran ? <div className="system-unavailable"><strong>No reconciliation has run yet</strong><span>Run one to compare recorded state against what Docker and the network actually report.</span></div>
      : report.error ? <div className="system-unavailable"><strong>Reconciliation could not complete</strong><span>{report.error.message}</span></div>
      : outstanding.length === 0 ? <div className="system-unavailable"><strong>Everything agrees</strong><span>{report.deploymentsInspected} deployment(s), {report.domainsInspected} hostname(s) checked{report.durationMs !== null ? ` in ${report.durationMs}ms` : ""}.</span></div>
      : <div className="reliability-findings">
          {outstanding.map((finding, index) => <div className="reliability-finding" key={`${finding.deploymentId}-${finding.hostname ?? ""}-${finding.code}-${index}`}>
            <span className={`status status-${tone[finding.outcome] ?? "blue"}`}><span className="status-dot" />{(outcomeLabel[finding.outcome] ?? finding.outcome).toUpperCase()}</span>
            <div>
              <strong>{finding.hostname ? finding.hostname : finding.code.replace(/_/g, " ")}</strong>
              <span>{finding.summary}</span>
              <small>{finding.target}{finding.deploymentId ? ` · ${finding.deploymentId.slice(0, 12)}` : ""}</small>
            </div>
            <div className="reliability-finding-action">{remediation(finding)}</div>
          </div>)}
        </div>}

    {report && report.actions.filter((action) => action.applied).length > 0 && <div className="reliability-applied">
      <strong>Corrections applied</strong>
      <ul>{report.actions.filter((action) => action.applied).map((action, index) => <li key={index}>{action.note}</li>)}</ul>
    </div>}
  </section>;
}