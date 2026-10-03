"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Project = { id: string; name: string; slug: string; description: string | null; status: "active" | "paused" | "archived"; githubOwner: string | null; githubRepo: string | null; updatedAt: string };
type Repository = { id: number; name: string; owner: string; visibility: string; description: string | null };
type ErrorState = { code?: string; message?: string };

const statusLabel = (value: Project["status"]) => value.charAt(0).toUpperCase() + value.slice(1);

export default function ProjectWorkspaceList() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorState | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [repositoryLoading, setRepositoryLoading] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({ name: "", description: "", status: "active", repository: "" });

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status !== "all") params.set("status", status);
    fetch(`/api/projects?${params}`, { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw body; return body; }).then((body) => { if (!cancelled) { setProjects(body.items || []); setLoading(false); setError(null); } }).catch((reason: ErrorState) => { if (!cancelled) { setError(reason); setLoading(false); } });
    return () => { cancelled = true; };
  }, [search, status]);

  const openCreate = () => {
    setCreateOpen(true); setFormError(""); setRepositoryLoading(true);
    fetch("/api/github/repositories", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw body; return body; }).then((body) => setRepositories(body.items || [])).catch(() => setRepositories([])).finally(() => setRepositoryLoading(false));
  };
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); setFormError("");
    const selected = repositories.find((repository) => String(repository.id) === form.repository);
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, description: form.description, status: form.status, githubOwner: selected?.owner || null, githubRepo: selected?.name || null }) });
    const body = await response.json();
    if (!response.ok) { setFormError(body.message || "Project could not be created."); return; }
    setProjects((current) => [body.project, ...current]); setCreateOpen(false); setForm({ name: "", description: "", status: "active", repository: "" });
  };
  const visibleRepositories = repositories.filter((repository) => `${repository.owner}/${repository.name}`.toLowerCase().includes(repositorySearch.toLowerCase()));
  return <><div className="page-header"><div><h1>Projects</h1><p>Organize repositories, containers, and activity in one workspace.</p></div><button className="primary-button" onClick={openCreate}>+ New project</button></div><div className="toolbar"><label className="search-field"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" aria-label="Search projects" /></label><select className="secondary-button status-select" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter projects by status"><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select></div>{loading && <div className="panel state-block" role="status"><strong>Loading projects</strong><span>Reading your project workspace.</span></div>}{!loading && error && <div className="github-state github-error" role="alert"><strong>{error.code === "not_authenticated" ? "Connect GitHub to manage projects" : "Projects unavailable"}</strong><span>{error.message || "The project workspace could not be loaded."}</span>{error.code === "not_authenticated" && <a className="primary-button" href="/api/auth/github">Connect GitHub</a>}</div>}{!loading && !error && !projects.length && <div className="panel state-block"><strong>Create your first project</strong><span>Connect a repository, containers, and activity when you are ready.</span><button className="text-button" onClick={openCreate}>Create project</button></div>}{!loading && !error && projects.length > 0 && <section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Name</th><th>Description</th><th>Status</th><th>GitHub</th><th>Updated</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id}><td><Link className="repo-link" href={`/projects/${project.id}`}><strong>{project.name}</strong></Link></td><td className="description-cell">{project.description || "-"}</td><td><span className={`status status-${project.status === "active" ? "green" : project.status === "paused" ? "yellow" : "blue"}`}><span className="status-dot" />{statusLabel(project.status)}</span></td><td className="mono-cell">{project.githubOwner && project.githubRepo ? `${project.githubOwner}/${project.githubRepo}` : "Not connected"}</td><td className="muted-cell">{new Date(project.updatedAt).toLocaleDateString()}</td></tr>)}</tbody></table></div></section>}{createOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setCreateOpen(false)}><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="create-project-title" onMouseDown={(event) => event.stopPropagation()}><div className="panel-header"><h2 id="create-project-title">Create project</h2><button className="icon-button" onClick={() => setCreateOpen(false)} aria-label="Close create project dialog">×</button></div><form className="project-form" onSubmit={createProject}><label>Name<input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} autoFocus /></label><label>Description<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} rows={3} /></label><label>Status<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="active">Active</option><option value="paused">Paused</option><option value="archived">Archived</option></select></label><label>GitHub repository{repositoryLoading ? <span className="form-note">Loading accessible repositories...</span> : <><input value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} placeholder="Filter repositories" /><select value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })}><option value="">No repository connected</option>{visibleRepositories.map((repository) => <option value={repository.id} key={repository.id}>{repository.owner}/{repository.name} ({repository.visibility})</option>)}</select></>}</label>{!repositoryLoading && !repositories.length && <span className="form-note">No repository data is available. You can create the project without GitHub.</span>}{formError && <div className="form-error" role="alert">{formError}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>Cancel</button><button type="submit" className="primary-button">Create project</button></div></form></section></div>}</>;
}
