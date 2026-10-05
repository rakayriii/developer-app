"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Project = { id: string; name: string; slug: string; localRepositoryPath: string | null };
type Environment = { id: string; projectId: string; name: string; slug: string; type: string; hostPort: number; containerPort: number; healthPath: string; cpuLimit: string; memoryLimit: string; runMigrations?: boolean };
type RuntimeVariable = { name: string; secret: boolean; description: string; configured: boolean; value: string | null };
type Deployment = { id: string; project: { id: string; name: string; slug: string }; environment: { id: string; name: string; type: string; hostPort: number }; commitSha: string; branch: string | null; imageTag: string; dockerfile: string | null; containerId: string | null; containerName?: string | null; status: string; healthStatus: string | null; errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null };
type EnvironmentSummary = { id: string; name: string; slug: string; type: string; hostPort: number; containerPort: number; healthPath: string; projectId: string; project: { id: string; name: string; slug: string }; deployments: { id: string; status: string; healthStatus: string | null; commitSha: string; imageTag: string; dockerfile: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; errorMessage: string | null }[] };
type DeploymentLog = { id: string; timestamp: string; stream: string; message: string };
type FormState = { projectId: string; name: string; type: "development" | "staging" | "production"; repositoryPath: string; hostPort: string; containerPort: string; healthPath: string; runMigrations: boolean; variables: Record<string, string> };

const short = (value: string) => value.slice(0, 12);
const emptyForm: FormState = { projectId: "", name: "Development", type: "development", repositoryPath: "", hostPort: "8088", containerPort: "80", healthPath: "/", runMigrations: true, variables: {} };

export default function DeploymentWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [summaries, setSummaries] = useState<EnvironmentSummary[]>([]);
  const [items, setItems] = useState<Deployment[]>([]);
  const [selected, setSelected] = useState<Deployment | null>(null);
  const [logs, setLogs] = useState<DeploymentLog[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [allowed, setAllowed] = useState<RuntimeVariable[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const [deploymentResponse, projectResponse] = await Promise.all([fetch("/api/deployments", { cache: "no-store" }), fetch("/api/projects?per_page=50", { cache: "no-store" })]);
      const deploymentBody = await deploymentResponse.json();
      const projectBody = await projectResponse.json();
      if (!deploymentResponse.ok) throw new Error(deploymentBody.message || "Deployments could not be loaded.");
      if (!projectResponse.ok) throw new Error(projectBody.message || "Projects could not be loaded.");
      const projectItems = (projectBody.items || []) as Project[];
      const environmentLists = await Promise.all(projectItems.map(async (project) => { const response = await fetch(`/api/projects/${project.id}/environments`, { cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.message || `Environments for ${project.name} could not be loaded.`); return body as Environment[]; }));
      const summaries = ((deploymentBody.environments || []) as EnvironmentSummary[]).filter((summary) => projectItems.some((project) => project.id === summary.projectId));
      setProjects(projectItems);
      setEnvironments(environmentLists.flat());
      setSummaries(summaries);
      setItems((deploymentBody.items || []) as Deployment[]);
      setState("ready");
      setError("");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Deployments could not be loaded.");
    }
  };

  const select = async (deployment: Deployment) => {
    setSelected(deployment);
    const response = await fetch(`/api/deployments/${deployment.id}/logs`, { cache: "no-store" });
    if (response.ok) setLogs((await response.json() as { entries: DeploymentLog[] }).entries);
  };

  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(initial); }, []);

  const openForm = async () => {
    const project = projects[0];
    setForm({ ...emptyForm, projectId: project?.id || "", repositoryPath: project?.localRepositoryPath || "" });
    setFormOpen(true);
    setError("");
    setAllowed(await runtimeVariableCatalog(project?.id || ""));
  };

  const runtimeVariableCatalog = async (projectId: string): Promise<RuntimeVariable[]> => {
    if (!projectId) return [];
    try {
      const probe = await fetch(`/api/deployments/runtime-variables`, { cache: "no-store" });
      if (probe.ok) return (await probe.json()) as RuntimeVariable[];
    } catch { /* catalog is optional */ }
    return [];
  };

  const updateForm = (key: "name" | "repositoryPath" | "hostPort" | "containerPort" | "healthPath", value: string) => setForm((current) => ({ ...current, [key]: value }));
  const updateType = (value: FormState["type"]) => setForm((current) => ({ ...current, type: value }));

  const createEnvironment = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${form.projectId}/environments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, type: form.type, repositoryPath: form.repositoryPath, hostPort: Number(form.hostPort), containerPort: Number(form.containerPort), healthPath: form.healthPath, runMigrations: form.runMigrations }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Environment could not be created.");
      const variables = Object.entries(form.variables).filter(([, value]) => value.trim()).map(([name, value]) => ({ name, value }));
      if (variables.length) {
        const variableResponse = await fetch(`/api/projects/${form.projectId}/environments/${body.id}/variables`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variables }) });
        const variableBody = await variableResponse.json();
        if (!variableResponse.ok) throw new Error(variableBody.message || "Runtime variables could not be saved.");
      }
      setFormOpen(false);
      setNotice(`${body.name} environment created.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Environment could not be created.");
    } finally {
      setSaving(false);
    }
  };

  const deployEnvironment = async (environment: Environment) => {
    const project = projects.find((item) => item.id === environment.projectId);
    if (!project || !window.confirm(`Deploy ${project.name} to ${environment.name}?`)) return;
    setError("");
    try {
      const createResponse = await fetch("/api/deployments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: environment.projectId, environmentId: environment.id }) });
      const created = await createResponse.json();
      if (!createResponse.ok) throw new Error(created.message || "Deployment could not be created.");
      const deployResponse = await fetch(`/api/deployments/${created.id}/deploy`, { method: "POST" });
      const deployed = await deployResponse.json();
      if (!deployResponse.ok) throw new Error(deployed.message || "Deployment failed.");
      setNotice(`${environment.name} deployment completed.`);
      await load();
      setSelected(deployed);
      await select(deployed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deployment failed.");
      await load();
    }
  };

  const action = async (name: "rollback" | "stop") => {
    if (!selected || !window.confirm(name === "rollback" ? "Rollback to the previous successful deployment?" : "Stop this deployment?")) return;
    try {
      const response = await fetch(`/api/deployments/${selected.id}/${name}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || `${name} failed.`);
      setNotice(`${name} completed.`);
      await load();
      setSelected(body);
      await select(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${name} failed.`);
    }
  };

  const projectOptions = projects.length ? projects : [];
  return <div className="deployment-workspace">
    <div className="page-header"><div><h1>Deployments</h1><p>Local Docker deployments for configured project environments.</p></div><div className={`git-connection status-${state === "ready" ? "green" : state === "error" ? "yellow" : "blue"}`}><span className="status-dot" />{state === "ready" ? "Ready" : state === "loading" ? "Loading" : "Error"}</div></div>
    {error && <div className="git-banner" role="alert"><strong>Deployment unavailable</strong><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}
    <section className="git-section deployment-environments"><div className="git-section-header"><div><h2>Environments</h2><span>Deploy a validated local repository with server-controlled Docker settings.</span></div><button className="primary-button" onClick={openForm} disabled={!projects.length}>New Environment</button></div>{environments.length ? <div className="deployment-environment-list">{environments.map((environment) => { const project = projects.find((item) => item.id === environment.projectId); const summary = summaries.find((item) => item.id === environment.id); const history = summary?.deployments || []; const current = history[0]; return <div className="deployment-environment-card" key={environment.id}><div className="deployment-environment-row"><div><strong>{project?.name || "Unknown project"} · {environment.name}</strong><span>{environment.type} · {environment.hostPort}:{environment.containerPort} · health {environment.healthPath}{environment.runMigrations ? " · migrations on deploy" : ""}</span></div><div className="deployment-row-actions">{current ? <Link className="secondary-button" href={`/deployments/${current.id}`}>Open</Link> : null}<button className="secondary-button" onClick={() => void deployEnvironment(environment)}>Deploy</button></div></div>{current ? <div className="deployment-current"><div><span>Current</span><strong>{current.status} · {current.healthStatus || "no health"}</strong></div><div><span>Commit</span><code>{short(current.commitSha)}</code></div><div><span>Image</span><code>{current.imageTag}</code></div><div><span>Deployed</span><time>{new Date(current.createdAt).toLocaleString()}</time></div></div> : <div className="deployment-current deployment-current-empty"><span>No deployments yet.</span></div>}{history.length > 1 ? <details className="deployment-previous"><summary>Previous deployments ({history.length - 1})</summary><div className="deployment-list">{history.slice(1).map((entry) => <Link className="deployment-row" key={entry.id} href={`/deployments/${entry.id}`}><span className={`deployment-status deployment-status-${entry.status}`}>{entry.status}</span><strong>{entry.healthStatus || "—"}</strong><code>{short(entry.commitSha)}</code><time>{new Date(entry.createdAt).toLocaleString()}</time></Link>)}</div></details> : null}</div>; })}</div> : <div className="deployment-empty"><strong>{projects.length ? "No environments configured" : "No projects available"}</strong><span>{projects.length ? "Create an environment to deploy a real local repository." : "Create a project before configuring a deployment environment."}</span>{projects.length ? <button className="primary-button" onClick={openForm}>Create Environment</button> : <Link className="primary-button" href="/#projects">Open Projects</Link>}</div>}</section>
    <div className="deployment-layout"><section className="git-section"><div className="git-section-header"><h2>History</h2><button className="secondary-button" onClick={() => void load()}>Refresh</button></div><div className="deployment-list">{items.length ? items.map((item) => <button className={`deployment-row ${selected?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => void select(item)}><span className={`deployment-status deployment-status-${item.status}`}>{item.status}</span><strong>{item.project.name}</strong><span>{item.environment.name}</span><code>{short(item.commitSha)}</code><time>{new Date(item.createdAt).toLocaleString()}</time></button>) : <div className="git-empty">No deployments yet. Create an environment above, then deploy it.</div>}</div></section>{selected ? <section className="git-section deployment-detail"><div className="git-section-header"><h2>{selected.project.name} · {selected.environment.name}</h2><span>{selected.status}</span><Link className="secondary-button" href={`/deployments/${selected.id}`}>Open detail</Link></div><div className="deployment-facts"><div><span>Commit</span><strong>{short(selected.commitSha)}</strong></div><div><span>Branch</span><strong>{selected.branch || "Detached HEAD"}</strong></div><div><span>Dockerfile</span><strong>{selected.dockerfile || "Not resolved"}</strong></div><div><span>Image</span><strong>{selected.imageTag}</strong></div><div><span>Container</span><strong>{selected.containerName || (selected.containerId ? short(selected.containerId) : "Not started")}</strong></div><div><span>Health</span><strong>{selected.healthStatus || "Not checked"}</strong></div></div><div className="deployment-actions"><button className="secondary-button" onClick={() => void action("rollback")}>Rollback</button><button className="danger-button secondary-button" onClick={() => void action("stop")}>Stop</button></div>{selected.errorMessage && <div className="git-banner"><strong>Deployment failed</strong><span>{selected.errorMessage}</span></div>}<h3 className="deployment-log-title">Logs</h3><pre className="git-diff deployment-logs">{logs.length ? logs.map((log) => `[${new Date(log.timestamp).toLocaleTimeString()}] ${log.stream}: ${log.message}`).join("\n") : "No deployment logs."}</pre></section> : <section className="git-section git-empty deployment-detail">Select a deployment to inspect its status and logs.</section>}</div>
    {formOpen && <div className="modal-backdrop" role="presentation"><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="create-environment-title"><div className="panel-header"><h2 id="create-environment-title">Create environment</h2><button className="icon-button" type="button" onClick={() => setFormOpen(false)} aria-label="Close environment form">×</button></div><form className="project-form" onSubmit={createEnvironment}><label>Project<select required value={form.projectId} onChange={(event) => { const project = projects.find((item) => item.id === event.target.value); setForm({ ...form, projectId: event.target.value, repositoryPath: project?.localRepositoryPath || "" }); }}>{projectOptions.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label>Environment name<input required value={form.name} onChange={(event) => updateForm("name", event.target.value)} /></label><label>Environment type<select value={form.type} onChange={(event) => updateType(event.target.value as FormState["type"])}><option value="development">development</option><option value="staging">staging</option><option value="production">production</option></select></label><label>Repository path<input required value={form.repositoryPath} onChange={(event) => updateForm("repositoryPath", event.target.value)} placeholder="GameVault or /home/skywalker/GameVault" /><span className="form-note">Must resolve inside GIT_WORKSPACE_ROOT. Dockerfile discovery remains server-side.</span></label><label>Host port<input required type="number" min="1" max="65535" value={form.hostPort} onChange={(event) => updateForm("hostPort", event.target.value)} /></label><label>Container port<input required type="number" min="1" max="65535" value={form.containerPort} onChange={(event) => updateForm("containerPort", event.target.value)} /></label><label>Health check path<input required value={form.healthPath} onChange={(event) => updateForm("healthPath", event.target.value)} placeholder="/" /></label><label className="form-checkbox"><input type="checkbox" checked={form.runMigrations} onChange={(event) => setForm({ ...form, runMigrations: event.target.checked })} /><span>Run database migrations on deploy</span></label><span className="form-note">Runs the fixed server-side command <code>php artisan migrate --force</code> inside the container after start.</span>{allowed.length ? <fieldset className="runtime-variables"><legend>Runtime environment</legend><span className="form-note">Injected at container start only. Never baked into the image, never returned by the API, never logged.</span>{allowed.map((variable) => <label key={variable.name}>{variable.name}{variable.secret ? <input type="password" autoComplete="new-password" value={form.variables[variable.name] || ""} onChange={(event) => setForm({ ...form, variables: { ...form.variables, [variable.name]: event.target.value } })} placeholder={variable.secret ? "write-only secret" : "value"} /> : <input value={form.variables[variable.name] || ""} onChange={(event) => setForm({ ...form, variables: { ...form.variables, [variable.name]: event.target.value } })} placeholder="value" />}<span className="form-note">{variable.secret ? "Secret. Stored encrypted and never displayed again." : variable.description}</span></label>)}</fieldset> : null}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "Creating" : "Create Environment"}</button></div></form></section></div>}
  </div>;
}
