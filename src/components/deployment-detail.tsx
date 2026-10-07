"use client";

import { readApiJson } from "@/lib/api/client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { groupLogsByStage, normalizeLogResponse, type DeploymentLogEntry } from "@/lib/deployments/logs";

type Project = { id: string; name: string; slug: string; localRepositoryPath: string | null };
type Environment = { id: string; name: string; slug: string; type: string; hostPort: number; containerPort: number; healthPath: string; healthTimeoutMs: number; healthRetries: number; cpuLimit: string; memoryLimit: string; runMigrations: boolean };
type HistoryEntry = { id: string; status: string; healthStatus: string | null; commitSha: string; imageTag: string; dockerfile: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; rollbackOfId: string | null; rolledBackFromId: string | null; errorMessage: string | null };
type ServerRef = { id: string; name: string; status: string; dockerAvailable: boolean; dockerVersion: string | null; architecture: string | null; hostKeyTrusted: boolean };
type Detail = { id: string; target?: "local" | "remote"; serverId?: string | null; server?: ServerRef | null; remoteImageTag?: string | null; transferBytes?: number | null; transferStartedAt?: string | null; transferCompletedAt?: string | null; healthVerifiedRemotely?: boolean; status: string; healthStatus: string | null; lastStage: string | null; errorMessage: string | null; stopReason: string | null; commitSha: string; branch: string | null; imageTag: string; dockerfile: string | null; containerId: string | null; containerName: string | null; rollbackOfId: string | null; rolledBackFromId: string | null; startedAt: string | null; finishedAt: string | null; restartedAt: string | null; createdAt: string; project: Project; environment: Environment; healthUrl: string; appUrl: string | null; history: HistoryEntry[] };
type Runtime = { owned: boolean; container: { state: string; running: boolean; health: string; restartCount: number; startedAt: string; image: string; restartPolicy: string; ports: string; cpuPercent: string; memoryUsage: string; memoryPercent: string } | null; runtimeVariableNames: string[]; secretNames?: string[] };
type Candidate = { id: string; commitSha: string; branch: string | null; imageTag: string; dockerfile: string | null; healthStatus: string | null; status: string; createdAt: string; finishedAt: string | null };
type Domain = { id: string; deploymentId: string; serverId: string; hostname: string; tlsEnabled: boolean; tlsMode: string; status: string; statusCode: string | null; statusMessage: string | null; routedDeploymentId: string | null; upstreamPort: number | null; serverName: string | null; deploymentStatus: string | null; createdAt: string; lastCheckedAt: string | null };

// Application exposure only exists for a remote deployment, since a hostname is routed on a registered
// server rather than on the local Docker host. The tab is absent rather than disabled elsewhere.
const baseTabs = ["Overview", "Runtime", "Logs", "History", "Environment"] as const;
const tabs = [...baseTabs, "Domains"] as const;
type Tab = (typeof tabs)[number];

const short = (value: string) => value.slice(0, 12);
const stamp = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
const dash = (value: string | null | undefined) => (value ? value : "—");
const uptime = (startedAt: string) => {
  if (!startedAt) return "—";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
};

const statusTone = (value: string | null) => (value === "running" || value === "healthy" ? "green" : value === "building" || value === "starting" || value === "stopping" || value === "pending" ? "yellow" : value === "failed" || value === "unhealthy" || value === "rolled_back" ? "red" : "blue");

function Badge({ value, tone }: { value: string | null; tone: string }) {
  if (!value) return null;
  return <span className={`status status-${tone}`}><span className="status-dot" />{value.toUpperCase()}</span>;
}

// A row value is described declaratively rather than as JSX so the array carries no unkeyed
// elements and the rendering stays in one place.
type Cell = string | number | { mono: string } | { link: string } | { badge: string; tone: string };

function cellValue(cell: Cell) {
  if (typeof cell === "string" || typeof cell === "number") return cell;
  if ("mono" in cell) return <code className="mono-cell">{cell.mono}</code>;
  if ("link" in cell) return <a href={cell.link} target="_blank" rel="noreferrer">{cell.link}</a>;
  return <Badge value={cell.badge} tone={cell.tone} />;
}

// Definition rows follow the repository-detail pattern: a compact dl with the label left and the
// value right-aligned, so long values stay readable without becoming oversized cards.
function Rows({ items }: { items: [string, Cell][] }) {
  return <dl className="detail-list">{items.map(([label, cell]) => <div key={label}><dt>{label}</dt><dd>{cellValue(cell)}</dd></div>)}</dl>;
}

export default function DeploymentDetail({ deploymentId }: { deploymentId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [logs, setLogs] = useState<DeploymentLogEntry[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState("");
  const [tab, setTab] = useState<Tab>("Overview");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [domains, setDomains] = useState<Domain[]>([]);
  const [hostname, setHostname] = useState("");
  const [tlsMode, setTlsMode] = useState("internal_ca");
  const [allowLocal, setAllowLocal] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detailResponse, runtimeResponse, logResponse] = await Promise.all([fetch(`/api/deployments/${deploymentId}`, { cache: "no-store" }), fetch(`/api/deployments/${deploymentId}/runtime`, { cache: "no-store" }), fetch(`/api/deployments/${deploymentId}/logs`, { cache: "no-store" })]);
      const detailResult = await readApiJson<Detail>(detailResponse);
      if (!detailResult.ok) throw new Error(detailResult.error.message);
      const detailBody = detailResult.data;
      setDetail(detailBody as Detail);
      const runtimeResult = await readApiJson<Runtime>(runtimeResponse);
      if (runtimeResult.ok) setRuntime(runtimeResult.data);
      const logResult = await readApiJson(logResponse);
      if (logResult.ok) setLogs(normalizeLogResponse(logResult.data));
      setState("ready");
      setError("");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Deployment could not be loaded.");
    }
  }, [deploymentId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  useEffect(() => {
    if (!detail) return;
    const tick = () => { void fetch(`/api/deployments/${deploymentId}/runtime`, { cache: "no-store" }).then((response) => (response.ok ? readApiJson<Runtime>(response).then((r) => (r.ok ? r.data : null)) : null)).then((body) => body && setRuntime(body)); };
    const interval = window.setInterval(tick, 5000);
    return () => window.clearInterval(interval);
  }, [detail, deploymentId]);

  const loadDomains = useCallback(async () => {
    const response = await fetch(`/api/domains?deploymentId=${encodeURIComponent(deploymentId)}`, { cache: "no-store" });
    const result = await readApiJson<{ items: Domain[] }>(response);
    if (!result.ok) { setError(result.error.message); return; }
    setDomains(result.data.items);
  }, [deploymentId]);

  const domainAction = async (action: "create" | "enable" | "disable" | "delete", id?: string) => {
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch(
        action === "create" ? "/api/domains" : `/api/domains/${encodeURIComponent(id ?? "")}`,
        action === "create"
          ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deploymentId, hostname, tlsMode, tlsEnabled: tlsMode !== "none", allowLocal }) }
          : { method: action === "delete" ? "DELETE" : "POST", ...(action === "delete" ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }) },
      );
      const result = await readApiJson(response);
      if (!result.ok) throw new Error(result.error.message);
      if (action === "create") { setHostname(""); setAllowLocal(false); setNotice(`${hostname} routed.`); }
      await loadDomains();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The domain could not be updated.");
    } finally {
      setBusy("");
    }
  };

  const loadCandidates = useCallback(async () => {
    const response = await fetch(`/api/deployments/${deploymentId}/rollback-candidates`, { cache: "no-store" });
    const result = await readApiJson<Candidate[]>(response);
    if (!result.ok) { setError(result.error.message); return; }
    const body = result.data;
    setCandidates(body);
    setRollbackTarget((current) => (body.some((item) => item.id === current) ? current : body[0]?.id || ""));
  }, [deploymentId]);

  // Candidates load on demand from the tab click rather than in an effect, matching the previous
  // explicit Rollback action and avoiding a synchronous setState inside an effect.
  const selectTab = (next: Tab) => {
    setTab(next);
    if (next === "History") void loadCandidates();
    // Loaded on tab entry rather than with the page, so a deployment with no domains costs one request
    // only when the tab is actually opened.
    if (next === "Domains") void loadDomains();
  };

  const act = async (action: "stop" | "restart" | "redeploy" | "rollback") => {
    if (action === "rollback" && !rollbackTarget) return;
    const prompts: Record<string, string> = { stop: "Stop this deployment's container?", restart: "Restart this deployment's container and re-run the health check?", redeploy: "Create a new deployment from the current repository state? History is preserved.", rollback: `Roll back to deployment ${short(rollbackTarget)}?` };
    if (!window.confirm(prompts[action])) return;
    setBusy(action); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/deployments/${deploymentId}/${action}`, { method: "POST", ...(action === "rollback" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetDeploymentId: rollbackTarget }) } : {}) });
      const actionResult = await readApiJson<Detail>(response);
      if (!actionResult.ok) throw new Error(actionResult.error.message);
      setNotice(`${action} completed.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${action} failed.`);
      await load();
    } finally {
      setBusy("");
    }
  };

  if (state === "loading") return <div className="detail-page"><Link className="back-link" href="/deployments">← Back to Deployments</Link><div className="panel state-block" role="status"><strong>Loading deployment</strong><span>Reading deployment state and logs.</span></div></div>;
  if (state === "error" || !detail) return <div className="detail-page"><Link className="back-link" href="/deployments">← Back to Deployments</Link><div className="github-state github-error" role="alert"><strong>Deployment unavailable</strong><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button></div></div>;

  const { ordered: logGroups, other: otherLogs } = groupLogsByStage(logs);
  const container = runtime?.container ?? null;
  const canAct = !busy;

  return <div className="detail-page">
    <Link className="back-link" href="/deployments">← Back to Deployments</Link>

    <header className="repository-header">
      <div>
        <div className="repository-kicker">Deployments / {detail.project.name} / {detail.environment.name}</div>
        <h1>{detail.project.name} <span className="deployment-slash">/</span> {detail.environment.name}</h1>
        <p>Deployment {short(detail.id)} · commit {short(detail.commitSha)} · {detail.target === "remote" ? `remote on ${detail.server?.name || "a registered server"}` : "local Docker"}</p>
      </div>
      <div className="header-actions deployment-header-status">
        <Badge value={detail.status} tone={statusTone(detail.status)} />
        <Badge value={detail.healthStatus} tone={statusTone(detail.healthStatus)} />
      </div>
    </header>

    <div className="deployment-action-bar">
      {detail.appUrl ? <a className="primary-button" href={detail.appUrl} target="_blank" rel="noreferrer noopener">Open App</a> : <button className="primary-button" disabled title="Available when the deployment is running">Open App</button>}
      <button className="secondary-button" onClick={() => void act("restart")} disabled={!canAct || !detail.containerId}>Restart</button>
      <button className="secondary-button" onClick={() => void act("redeploy")} disabled={!canAct}>Redeploy</button>
      <button className="secondary-button" onClick={() => selectTab("History")} disabled={!canAct || !detail.history.length}>Rollback</button>
      <button className="secondary-button danger-button" onClick={() => void act("stop")} disabled={!canAct || !detail.containerId}>Stop</button>
    </div>

    {error && <div className="github-state github-error" role="alert"><strong>Operation failed</strong><span>{error}</span></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}
    {detail.errorMessage && <div className="github-state github-error" role="alert"><strong>Deployment failed</strong><span>{detail.errorMessage}</span></div>}

    <div className="repository-meta">
      <span>{detail.environment.type}</span>
      <span>{detail.environment.hostPort}:{detail.environment.containerPort}</span>
      <span>{dash(detail.branch)}</span>
      <span>{dash(detail.dockerfile)}</span>
      <span>Created {stamp(detail.createdAt)}</span>
    </div>

    <div className="tabs" role="tablist">{tabs.filter((item) => item !== "Domains" || detail.target === "remote").map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "tab active" : "tab"} onClick={() => selectTab(item)} key={item}>{item}</button>)}</div>

    {tab === "Overview" && <>
      <section className="panel detail-section overview-panel"><div className="panel-header"><h2>Deployment overview</h2></div><Rows items={[
        ["Project", detail.project.name],
        ["Environment", `${detail.environment.name} (${detail.environment.type})`],
        ["Status", { badge: detail.status, tone: statusTone(detail.status) }],
        ["Health", dash(detail.healthStatus)],
        ["Last stage", dash(detail.lastStage)],
        ["Stop reason", dash(detail.stopReason)],
      ]} /></section>
      <section className="panel detail-section overview-panel"><div className="panel-header"><h2>Build</h2></div><Rows items={[
        ["Commit", { mono: detail.commitSha }],
        ["Branch", dash(detail.branch)],
        ["Dockerfile", dash(detail.dockerfile)],
        ["Image", { mono: detail.imageTag }],
        ["Container", { mono: dash(detail.containerName) }],
        ["Repository path", dash(detail.project.localRepositoryPath)],
        ...(detail.target === "remote" ? [
          ["Remote image", { mono: dash(detail.remoteImageTag) }],
          ["Transferred", detail.transferBytes ? `${(detail.transferBytes / 1024 / 1024).toFixed(1)} MB` : "—"],
        ] as [string, string | { mono: string }][] : []),
      ]} /></section>
      {detail.target === "remote" ? <section className="panel detail-section"><div className="panel-header"><h2>Remote target</h2></div><Rows items={[
        ["Server", detail.server?.name || "—"],
        ["Connection", detail.server?.hostKeyTrusted ? "SSH verified" : "Host key untrusted"],
        ["Docker", detail.server?.dockerAvailable ? dash(detail.server?.dockerVersion) : "Unavailable"],
        ["Architecture", dash(detail.server?.architecture)],
        ["Server status", dash(detail.server?.status)],
        ["Health verified", detail.healthVerifiedRemotely ? "On the remote host over SSH" : "—"],
      ]} /></section> : null}
      <section className="panel detail-section"><div className="panel-header"><h2>Endpoints</h2></div><Rows items={[
        ["Host port", detail.environment.hostPort],
        ["Container port", detail.environment.containerPort],
        ["Health URL", { link: detail.healthUrl }],
        ["App URL", detail.appUrl ? { link: detail.appUrl } : "—"],
        ["Created", stamp(detail.createdAt)],
        ["Started", stamp(detail.startedAt)],
        ["Completed", stamp(detail.finishedAt)],
        ["Last restarted", stamp(detail.restartedAt)],
        ["Rollback of", detail.rollbackOfId ? short(detail.rollbackOfId) : "—"],
        ["Rolled back from", detail.rolledBackFromId ? short(detail.rolledBackFromId) : "—"],
      ]} /></section>
    </>}

    {tab === "Runtime" && <>
      <section className="panel detail-section"><div className="panel-header"><h2>Container</h2><button className="secondary-button" onClick={() => void load()}>Refresh</button></div>
        {container ? <Rows items={[
          ["State", container.state],
          ["Running", String(container.running)],
          ["Docker health", container.health],
          ["Uptime", uptime(container.startedAt)],
          ["Started at", stamp(container.startedAt)],
          ["Restart count", String(container.restartCount)],
          ["Restart policy", container.restartPolicy],
          ["Image", { mono: container.image }],
          ["Port mapping", { mono: container.ports }],
          ["CPU", container.cpuPercent],
          ["Memory", `${container.memoryUsage} (${container.memoryPercent})`],
        ]} /> : <div className="state-block"><strong>No owned container</strong><span>{runtime?.owned === false ? "The container owned by this deployment no longer exists on this host." : "This deployment has no container attached."}</span></div>}
      </section>
      <section className="panel detail-section"><div className="panel-header"><h2>Runtime variables</h2></div>
        {runtime?.runtimeVariableNames.length ? <ul className="github-list deployment-variable-list">{runtime.runtimeVariableNames.map((name) => <li key={name}><div><strong>{name}</strong><span>Configured · injected at container start</span></div>{runtime.secretNames?.includes(name) ? <span className="deployment-tag secret">Secret</span> : null}</li>)}</ul> : <div className="state-block"><strong>No runtime variables configured</strong><span>This environment injects no application configuration.</span></div>}
        <p className="deployment-note">Names only. Secret values are encrypted at rest, are never returned by the API, and are never logged.</p>
      </section>
    </>}

    {tab === "Logs" && <section className="panel"><div className="panel-header"><h2>Logs</h2><span className="muted-cell">{logs.length} entries</span></div>
      {logGroups.length || otherLogs.length ? <div className="deployment-log-groups">{logGroups.map((group) => <div className="deployment-log-group" key={group.stage}><h3 className="deployment-log-stage">{group.stage}<span>{group.entries.length}</span></h3><pre className="git-diff deployment-logs">{group.entries.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.severity === "error" ? "ERROR" : "info "} ${entry.message}`).join("\n")}</pre></div>)}</div> : <div className="state-block"><strong>No logs recorded</strong><span>This deployment has no persisted log entries.</span></div>}
      {otherLogs.length ? <div className="deployment-log-group"><h3 className="deployment-log-stage">other<span>{otherLogs.length}</span></h3><pre className="git-diff deployment-logs">{otherLogs.map((entry) => `[${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.message}`).join("\n")}</pre></div> : null}
    </section>}

    {tab === "History" && <>
      <section className="panel table-panel"><div className="panel-header"><h2>Previous deployments</h2></div>
        {detail.history.length ? <div className="table-wrap"><table><thead><tr><th>Status</th><th>Health</th><th>Commit</th><th>Image</th><th>Created</th></tr></thead><tbody>{detail.history.map((item) => <tr key={item.id}><td className="strong-cell">{item.status}</td><td>{dash(item.healthStatus)}</td><td><Link className="repo-link" href={`/deployments/${item.id}`}><code className="mono-cell">{short(item.commitSha)}</code></Link></td><td className="mono-cell">{item.imageTag}</td><td className="muted-cell">{stamp(item.createdAt)}</td></tr>)}</tbody></table></div> : <div className="state-block"><strong>No previous deployments</strong><span>This is the first deployment recorded for this environment.</span></div>}
      </section>
      <section className="panel detail-section"><div className="panel-header"><h2>Rollback candidates</h2><button className="secondary-button" onClick={() => void loadCandidates()}>Refresh candidates</button></div>
        {candidates.length ? <><div className="table-wrap"><table><thead><tr><th /><th>Deployment</th><th>Commit</th><th>Image</th><th>Health</th><th>Created</th></tr></thead><tbody>{candidates.map((candidate) => <tr key={candidate.id} className={rollbackTarget === candidate.id ? "deployment-row-selected" : undefined}><td><input type="radio" name="rollback-target" aria-label={`Roll back to deployment ${short(candidate.id)}`} checked={rollbackTarget === candidate.id} onChange={() => setRollbackTarget(candidate.id)} /></td><td className="mono-cell">{short(candidate.id)}</td><td className="mono-cell">{short(candidate.commitSha)}</td><td className="mono-cell">{candidate.imageTag}</td><td>{dash(candidate.healthStatus)}</td><td className="muted-cell">{stamp(candidate.createdAt)}</td></tr>)}</tbody></table></div><div className="panel-header deployment-rollback-action"><button className="primary-button" onClick={() => void act("rollback")} disabled={!canAct || !rollbackTarget}>Roll back to selected</button></div></> : <div className="state-block"><strong>No eligible image</strong><span>No previous successful deployment image is available locally.</span></div>}
      </section>
    </>}

    {tab === "Environment" && <>
      <section className="panel detail-section"><div className="panel-header"><h2>Environment</h2><Link className="text-button" href="/deployments">Manage environments</Link></div><Rows items={[
        ["Name", detail.environment.name],
        ["Slug", detail.environment.slug],
        ["Type", detail.environment.type],
        ["Host port", detail.environment.hostPort],
        ["Container port", detail.environment.containerPort],
        ["Health path", detail.environment.healthPath],
        ["Health timeout", `${detail.environment.healthTimeoutMs} ms`],
        ["Health retries", detail.environment.healthRetries],
        ["CPU limit", detail.environment.cpuLimit],
        ["Memory limit", detail.environment.memoryLimit],
        ["Run migrations", detail.environment.runMigrations ? "Yes" : "No"],
      ]} /></section>
    </>}

    {tab === "Domains" && detail.target === "remote" && <>
      <section className="panel detail-section"><div className="panel-header"><h2>Add a hostname</h2></div>
        <form className="project-form" onSubmit={(event) => { event.preventDefault(); void domainAction("create"); }}>
          <label>Hostname<input required value={hostname} onChange={(event) => setHostname(event.target.value)} placeholder="app.example.com" spellCheck={false} autoComplete="off" inputMode="url" />
            <span className="form-note">A name only. A protocol, path, port, or wildcard is refused rather than rewritten.</span>
          </label>
          <label>TLS
            <select value={tlsMode} onChange={(event) => setTlsMode(event.target.value)}>
              <option value="internal_ca">Local certificate authority — real HTTPS, trusted by installing the proxy root</option>
              <option value="automatic">Automatic — asks Let&apos;s Encrypt, needs DNS pointing at this server</option>
              <option value="none">None — plain HTTP on port 80</option>
            </select>
            <span className="form-note">Automatic HTTPS needs the server reachable on port 80 with DNS already pointing at it.</span>
          </label>
          <label className="deployment-checkbox"><input type="checkbox" checked={allowLocal} onChange={(event) => setAllowLocal(event.target.checked)} />Allow a localhost name
            <span className="form-note">Off by default. Only useful when you reach the server from the same machine.</span>
          </label>
          <div className="form-actions"><button type="submit" className="primary-button" disabled={!canAct || !hostname.trim()}>Route hostname</button></div>
        </form>
      </section>

      <section className="panel table-panel"><div className="panel-header"><h2>Routed hostnames</h2><button className="secondary-button" onClick={() => void loadDomains()}>Refresh</button></div>
        {domains.length ? <div className="table-wrap"><table><thead><tr><th>Status</th><th>Hostname</th><th>TLS</th><th>Upstream</th><th>Checked</th><th /></tr></thead><tbody>{domains.map((domain) => <tr key={domain.id}>
          <td><Badge value={domain.status} tone={statusTone(domain.status === "active" ? "running" : domain.status === "failed" ? "failed" : "pending")} /><span className="muted-cell">{domain.statusMessage}</span></td>
          <td className="mono-cell">{domain.hostname}</td>
          <td>{domain.tlsEnabled && domain.tlsMode !== "none" ? domain.tlsMode.replace("_", " ") : "plain http"}</td>
          <td className="mono-cell">{domain.upstreamPort ? `127.0.0.1:${domain.upstreamPort}` : "—"}</td>
          <td className="muted-cell">{stamp(domain.lastCheckedAt)}</td>
          <td className="deployment-row-actions">
            <button className="text-button" onClick={() => void domainAction(domain.status === "disabled" ? "enable" : "disable", domain.id)} disabled={!canAct}>{domain.status === "disabled" ? "Enable" : "Disable"}</button>
            <button className="text-button deployment-danger-text" onClick={() => { if (window.confirm(`Remove ${domain.hostname} from the proxy?`)) void domainAction("delete", domain.id); }} disabled={!canAct}>Remove</button>
          </td>
        </tr>)}</tbody></table></div>
          : <div className="state-block"><strong>No hostnames routed</strong><span>This deployment is reachable on its host port only. Add a hostname above to put a reverse proxy in front of it.</span></div>}
      </section>

      <section className="panel detail-section"><div className="panel-header"><h2>How this is served</h2></div><Rows items={[
        ["Proxy", `Caddy on ${detail.server?.name || "the registered server"}`],
        ["Published ports", "80 and 443 only"],
        ["Upstream", `127.0.0.1:${detail.environment.hostPort} on the proxy host`],
        ["Reloads", "Validated, then reloaded in place — other hostnames are not interrupted"],
        ["Shared proxy", "One proxy serves every hostname on this server; removing the last hostname stops it"],
      ]} /><p className="deployment-note">A hostname follows the environment, so a redeploy or a rollback keeps serving under the same name. It is withdrawn only when nothing on the environment is serving.</p></section>
    </>}

    <section className="panel detail-section"><div className="panel-header"><h2>Security</h2></div><Rows items={[
        ["Runtime secrets", runtime?.secretNames?.length ? `${runtime.secretNames.length} configured, encrypted at rest` : "None configured"],
        ["Credential exposure", "Never returned by the API or written to a log"],
        ["Host port mapping", "Loopback only, bound by the deployment engine"],
      ]} /><p className="deployment-note">Secret values are write-only. A stored secret is reported as Configured and is never displayed again.</p></section>
  </div>;
}
