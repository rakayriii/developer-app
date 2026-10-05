"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Project = { id: string; name: string; slug: string; localRepositoryPath: string | null };
type Environment = { id: string; name: string; slug: string; type: string; hostPort: number; containerPort: number; healthPath: string; healthTimeoutMs: number; healthRetries: number; cpuLimit: string; memoryLimit: string; runMigrations: boolean };
type HistoryEntry = { id: string; status: string; healthStatus: string | null; commitSha: string; imageTag: string; dockerfile: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; rollbackOfId: string | null; rolledBackFromId: string | null; errorMessage: string | null };
type Detail = { id: string; status: string; healthStatus: string | null; lastStage: string | null; errorMessage: string | null; stopReason: string | null; commitSha: string; branch: string | null; imageTag: string; dockerfile: string | null; containerId: string | null; containerName: string | null; rollbackOfId: string | null; rolledBackFromId: string | null; startedAt: string | null; finishedAt: string | null; restartedAt: string | null; createdAt: string; project: Project; environment: Environment; healthUrl: string; appUrl: string | null; history: HistoryEntry[] };
type Runtime = { owned: boolean; container: { state: string; running: boolean; health: string; restartCount: number; startedAt: string; image: string; restartPolicy: string; ports: string; cpuPercent: string; memoryUsage: string; memoryPercent: string } | null; runtimeVariableNames: string[]; secretNames?: string[] };
type LogEntry = { id: string; timestamp: string; stage: string; severity: string; message: string };
type Candidate = { id: string; commitSha: string; branch: string | null; imageTag: string; dockerfile: string | null; healthStatus: string | null; status: string; createdAt: string; finishedAt: string | null };
type Section = "overview" | "runtime" | "logs" | "history" | "environment";

const sections: { id: Section; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "runtime", label: "Runtime" }, { id: "logs", label: "Logs" }, { id: "history", label: "History" }, { id: "environment", label: "Environment" }];
const short = (value: string) => value.slice(0, 12);
const time = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
const uptime = (startedAt: string) => {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
};
const stageOrder = ["validation", "build", "container", "port", "release", "health", "runtime", "stop", "restart", "rollback"];

export default function DeploymentDetail({ deploymentId }: { deploymentId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [section, setSection] = useState<Section>("overview");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState("");

  const load = useCallback(async () => {
    try {
      const [detailResponse, runtimeResponse, logResponse] = await Promise.all([fetch(`/api/deployments/${deploymentId}`, { cache: "no-store" }), fetch(`/api/deployments/${deploymentId}/runtime`, { cache: "no-store" }), fetch(`/api/deployments/${deploymentId}/logs`, { cache: "no-store" })]);
      const detailBody = await detailResponse.json();
      if (!detailResponse.ok) throw new Error(detailBody.message || "Deployment could not be loaded.");
      setDetail(detailBody as Detail);
      if (runtimeResponse.ok) setRuntime(await runtimeResponse.json());
      if (logResponse.ok) setLogs(((await logResponse.json()) as { entries: LogEntry[] }).entries);
      setState("ready");
      setError("");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Deployment could not be loaded.");
    }
  }, [deploymentId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { if (!detail) return; const timer = window.setInterval(() => { void fetch(`/api/deployments/${deploymentId}/runtime`, { cache: "no-store" }).then((response) => (response.ok ? response.json() : null)).then((body) => body && setRuntime(body)); }, 5000); return () => window.clearInterval(timer); }, [detail, deploymentId]);

  const openRollback = async () => {
    setSection("history");
    const response = await fetch(`/api/deployments/${deploymentId}/rollback-candidates`, { cache: "no-store" });
    if (response.ok) { const body = (await response.json()) as Candidate[]; setCandidates(body); setRollbackTarget(body[0]?.id || ""); }
    else setError(((await response.json()) as { message?: string }).message || "Rollback candidates could not be loaded.");
  };

  const act = async (action: "stop" | "restart" | "redeploy" | "rollback") => {
    if (action === "rollback" && !rollbackTarget) return;
    const prompts: Record<string, string> = { stop: "Stop this deployment's container?", restart: "Restart this deployment's container and re-run the health check?", redeploy: "Create a new deployment from the current repository state? History is preserved.", rollback: `Roll back to deployment ${short(rollbackTarget)}?` };
    if (!window.confirm(prompts[action])) return;
    setBusy(action); setError(""); setNotice("");
    try {
      if (action === "rollback") await openRollback();
      const response = await fetch(`/api/deployments/${deploymentId}/${action}`, { method: "POST", ...(action === "rollback" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetDeploymentId: rollbackTarget }) } : {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `${action} failed.`);
      setNotice(`${action} completed.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${action} failed.`);
    } finally {
      setBusy("");
    }
  };

  if (state === "loading") return <div className="deployment-workspace"><div className="page-header"><div><h1>Deployment</h1><p>Loading real deployment state.</p></div><div className="git-connection status-blue"><span className="status-dot" />Loading</div></div></div>;

  if (state === "error" || !detail) return <div className="deployment-workspace"><div className="page-header"><div><h1>Deployment</h1><p>{error}</p></div><Link className="secondary-button" href="/deployments">Back</Link></div><div className="git-banner" role="alert"><strong>Deployment unavailable</strong><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button></div></div>;

  const container = runtime?.container ?? null;
  const containerFacts: [string, string][] = container ? [["Container state", container.state], ["Running", String(container.running)], ["Docker health", container.health], ["Uptime", uptime(container.startedAt)], ["Started at", time(container.startedAt)], ["Restart count", String(container.restartCount)], ["Restart policy", container.restartPolicy], ["Image", container.image], ["Port mapping", container.ports], ["CPU", container.cpuPercent], ["Memory", `${container.memoryUsage} (${container.memoryPercent})`]] : [];
  const grouped = stageOrder.map((stage) => ({ stage, entries: logs.filter((entry) => entry.stage === stage) })).filter((group) => group.entries.length);
  const other = logs.filter((entry) => !stageOrder.includes(entry.stage));

  return <div className="deployment-workspace">
    <div className="page-header">
      <div><div className="deployment-breadcrumb"><Link href="/deployments">Deployments</Link><span>/</span><span>{detail.project.name} / {detail.environment.name}</span></div><h1>{detail.project.name} <span className="deployment-slash">/</span> {detail.environment.name}</h1><p>Deployment {short(detail.id)} · commit {short(detail.commitSha)}</p></div>
      <div className="deployment-header-status"><span className={`deployment-status deployment-status-${detail.status}`}>{detail.status}</span><span className={`deployment-health deployment-health-${detail.healthStatus || "unknown"}`}>{detail.healthStatus || "unknown"}</span></div>
    </div>

    {error && <div className="git-banner" role="alert"><strong>Operation failed</strong><span>{error}</span></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}

    <div className="deployment-actions deployment-action-bar">
      {detail.appUrl ? <a className="primary-button" href={detail.appUrl} target="_blank" rel="noreferrer noopener">Open App</a> : <button className="primary-button" disabled title="Available when the deployment is running">Open App</button>}
      <button className="secondary-button" onClick={() => void act("restart")} disabled={Boolean(busy) || !detail.containerId}>Restart</button>
      <button className="secondary-button" onClick={() => void act("redeploy")} disabled={Boolean(busy)}>Redeploy</button>
      <button className="secondary-button" onClick={() => void openRollback()} disabled={Boolean(busy) || !detail.history.length}>Rollback</button>
      <button className="secondary-button danger-button" onClick={() => void act("stop")} disabled={Boolean(busy) || !detail.containerId}>Stop</button>
    </div>

    {detail.errorMessage && <div className="git-banner"><strong>Deployment failed</strong><span>{detail.errorMessage}</span></div>}

    <nav className="deployment-tabs">{sections.map((item) => <button key={item.id} className={`deployment-tab ${section === item.id ? "active" : ""}`} onClick={() => setSection(item.id)}>{item.label}</button>)}</nav>

    {section === "overview" && <section className="git-section"><div className="deployment-facts deployment-facts-dense">
      {([["Project", detail.project.name], ["Environment", `${detail.environment.name} (${detail.environment.type})`], ["Status", detail.status], ["Last stage", detail.lastStage || "—"], ["Health", detail.healthStatus || "—"], ["Commit", detail.commitSha], ["Branch", detail.branch || "Detached HEAD"], ["Repository path", detail.project.localRepositoryPath || "—"], ["Dockerfile", detail.dockerfile || "Not resolved"], ["Image", detail.imageTag], ["Container name", detail.containerName || "Not started"], ["Container id", detail.containerId ? short(detail.containerId) : "—"], ["Host port", detail.environment.hostPort], ["Container port", detail.environment.containerPort], ["Health URL", detail.healthUrl], ["App URL", detail.appUrl || "Not available"], ["Created", time(detail.createdAt)], ["Started", time(detail.startedAt)], ["Completed", time(detail.finishedAt)], ["Last restarted", time(detail.restartedAt)], ["Rollback of", detail.rollbackOfId ? short(detail.rollbackOfId) : "—"], ["Rolled back from", detail.rolledBackFromId ? short(detail.rolledBackFromId) : "—"], ["Stop reason", detail.stopReason || "—"]] as [string, string | number][]).map(([label, value]) => <div key={label}><span>{label}</span><strong className={typeof value === "string" && (value.startsWith("developer-os/") || value.length === 40) ? "mono" : ""}>{value}</strong></div>)}
    </div></section>}

    {section === "runtime" && <section className="git-section"><div className="git-section-header"><h2>Runtime</h2><button className="secondary-button" onClick={() => void load()}>Refresh</button></div>
      {!container ? <div className="git-empty">{runtime?.owned === false ? "The owned container no longer exists on this host." : "No owned container is attached to this deployment."}</div> : <div className="deployment-facts deployment-facts-dense">
        {containerFacts.map(([label, value]) => <div key={label}><span>{label}</span><strong className={label === "Image" ? "mono" : ""}>{value}</strong></div>)}
      </div>}
      <h3 className="deployment-log-title">Runtime variables</h3><p className="form-note">Names only. Secret values are encrypted at rest, injected at container start, and never returned or logged.</p><div className="deployment-tags">{runtime?.runtimeVariableNames.length ? runtime.runtimeVariableNames.map((name) => <span className={`deployment-tag ${runtime.secretNames?.includes(name) ? "secret" : ""}`} key={name}>{name}{runtime.secretNames?.includes(name) ? " · secret" : ""}</span>) : <span className="form-note">None configured.</span>}</div>
    </section>}

    {section === "logs" && <section className="git-section"><div className="git-section-header"><h2>Logs</h2><span>{logs.length} entries</span></div>
      {grouped.length || other.length ? grouped.map((group) => <div className="deployment-log-group" key={group.stage}><h3 className="deployment-log-stage">{group.stage}<span>{group.entries.length}</span></h3><pre className="git-diff deployment-logs">{group.entries.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.severity === "error" ? "ERROR" : "info "} ${entry.message}`).join("\n")}</pre></div>) : <div className="git-empty">No logs recorded.</div>}
      {other.length ? <div className="deployment-log-group"><h3 className="deployment-log-stage">other<span>{other.length}</span></h3><pre className="git-diff deployment-logs">{other.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.message}`).join("\n")}</pre></div> : null}
    </section>}

    {section === "history" && <section className="git-section"><div className="git-section-header"><h2>History</h2><button className="secondary-button" onClick={() => void openRollback()}>Refresh rollback candidates</button></div>
      {detail.history.length ? <div className="deployment-list">{detail.history.map((item) => <Link className={`deployment-row ${item.id === detail.id ? "selected" : ""}`} key={item.id} href={`/deployments/${item.id}`}><span className={`deployment-status deployment-status-${item.status}`}>{item.status}</span><strong>{item.healthStatus || "—"}</strong><code>{short(item.commitSha)}</code><span>{item.imageTag}</span><time>{new Date(item.createdAt).toLocaleString()}</time></Link>)}</div> : <div className="git-empty">No previous deployments in this environment.</div>}
      <h3 className="deployment-log-title">Rollback candidates</h3>
      {candidates.length ? <><div className="deployment-list">{candidates.map((candidate) => <label className={`deployment-row deployment-row-selectable ${rollbackTarget === candidate.id ? "selected" : ""}`} key={candidate.id}><input type="radio" name="rollback" checked={rollbackTarget === candidate.id} onChange={() => setRollbackTarget(candidate.id)} /><code>{short(candidate.id)}</code><strong>{short(candidate.commitSha)}</strong><span className="mono">{candidate.imageTag}</span><span>{candidate.healthStatus || "—"}</span><time>{new Date(candidate.createdAt).toLocaleString()}</time></label>)}</div><div className="deployment-actions"><button className="secondary-button" onClick={() => void act("rollback")} disabled={Boolean(busy) || !rollbackTarget}>Rollback to selected</button></div></> : <div className="git-empty">No eligible known-good image is available locally.</div>}
    </section>}

    {section === "environment" && <section className="git-section"><div className="git-section-header"><h2>Environment</h2><Link className="secondary-button" href="/deployments">Manage environments</Link></div><div className="deployment-facts deployment-facts-dense">
      {([["Name", detail.environment.name], ["Slug", detail.environment.slug], ["Type", detail.environment.type], ["Host port", detail.environment.hostPort], ["Container port", detail.environment.containerPort], ["Health path", detail.environment.healthPath], ["Health timeout", `${detail.environment.healthTimeoutMs} ms`], ["Health retries", detail.environment.healthRetries], ["CPU limit", detail.environment.cpuLimit], ["Memory limit", detail.environment.memoryLimit], ["Run migrations", detail.environment.runMigrations ? "Yes" : "No"]] as [string, string | number][]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div></section>}
  </div>;
}
