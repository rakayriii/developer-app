"use client";

import { useEffect, useState } from "react";
import GithubPhase2 from "@/components/github-phase2";
import DockerPhase3 from "@/components/docker-phase3";
import ProjectWorkspaceList from "@/components/project-workspace";
import TerminalWorkspace from "@/components/terminal-workspace";
import SystemWorkspace from "@/components/system-workspace";
import GitWorkspace from "@/components/git-workspace";
import DeploymentWorkspace from "@/components/deployment-workspace";
import { projects, systemMetrics } from "@/data/mock-data";

type Page = "overview" | "projects" | "terminal" | "git" | "deployments" | "tasks" | "notes" | "github" | "repositories" | "pull-requests" | "issues" | "docker" | "servers" | "system" | "settings";
type GithubAccount = { login: string; name: string | null; avatarUrl: string; htmlUrl: string };
type GithubRepository = { id: number; name: string; owner: string; description: string | null; language: string | null; stars: number; forks: number; visibility: string; updatedAt: string; htmlUrl: string };
type GithubActivity = { type: string; action: string; repository: string; title: string; actor: string; timestamp: string; url: string };
type GithubOverview = { account: GithubAccount; repositories: GithubRepository[]; pullRequests: { totalCount: number }; issues: { totalCount: number }; activity: { items: GithubActivity[] } };

const navGroups = [
  { label: "Workspace", items: [["Overview", "overview"], ["Projects", "projects"], ["Terminal", "terminal"], ["Git", "git"], ["Tasks", "tasks"], ["Notes", "notes"]] },
  { label: "Development", items: [["GitHub", "github"], ["Repositories", "repositories"], ["Pull Requests", "pull-requests"], ["Issues", "issues"]] },
  { label: "Infrastructure", items: [["Deployments", "deployments"], ["Docker", "docker"], ["Servers", "servers"], ["System", "system"]] },
] as const;

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
    check: "m5 12 4 4L19 6",
    note: "M6 3h9l3 3v15H6zM14 3v4h4M9 12h6M9 16h6",
    github: "M12 3a9 9 0 0 0-2.85 17.54c.45.08.61-.2.61-.43v-1.52c-2.5.54-3.03-1.06-3.03-1.06-.41-1.05-1-1.33-1-1.33-.82-.56.06-.55.06-.55.91.06 1.39.93 1.39.93.81 1.39 2.13.99 2.65.76.08-.59.32-.99.58-1.22-2-.23-4.1-1-4.1-4.45 0-.98.35-1.78.93-2.41-.09-.23-.4-1.14.09-2.37 0 0 .76-.24 2.48.92A8.6 8.6 0 0 1 12 7.51c.77 0 1.55.1 2.28.33 1.72-1.16 2.48-.92 2.48-.92.49 1.23.18 2.14.09 2.37.58.63.93 1.43.93 2.41 0 3.46-2.1 4.22-4.1 4.45.33.29.61.85.61 1.72v2.55c0 .23.16.51.62.42A9 9 0 0 0 12 3Z",
    box: "M4 7.5 12 3l8 4.5v9L12 21l-8-4.5zM4 7.5l8 4.5 8-4.5M12 12v9",
    server: "M4 5h16v5H4zM4 14h16v5H4zM7 7.5h.01M7 16.5h.01M10 7.5h7M10 16.5h7",
    settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm7.4 3.5a7.3 7.3 0 0 0-.08-1l2-1.55-2-3.46-2.35.95a7.4 7.4 0 0 0-1.72-1L14.9 3h-4l-.36 2.94a7.4 7.4 0 0 0-1.72 1l-2.35-.95-2 3.46 2 1.55a7.3 7.3 0 0 0 0 2l-2 1.55 2 3.46 2.35-.95a7.4 7.4 0 0 0 1.72 1L10.9 21h4l.36-2.94a7.4 7.4 0 0 0 1.72-1l2.35.95 2-3.46-2-1.55a7.3 7.3 0 0 0 .07-1Z",
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="icon"><path d={paths[name] ?? paths.grid} /></svg>;
}

function Status({ tone, children }: { tone: string; children: React.ReactNode }) { return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>; }

export default function DeveloperOS() {
  const [page, setPage] = useState<Page>("overview");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [notice, setNotice] = useState("");
  const [githubTab, setGithubTab] = useState("Repositories");
  useEffect(() => {
    const sync = () => setPage((window.location.hash.slice(1) || "overview") as Page);
    sync();
    window.addEventListener("hashchange", sync);
    const key = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); } if (event.key === "Escape") setPaletteOpen(false); };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("keydown", key); };
  }, []);
  const go = (destination: string) => { window.location.hash = destination; setMenuOpen(false); };
  const pageTitle = page === "pull-requests" ? "Pull Requests" : page.replace("-", " ");
  const notify = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(""), 2600); };
  return <div className={dark ? "app-shell dark" : "app-shell"}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}><div className="brand"><span className="brand-mark">D</span><span>Developer OS</span></div><nav aria-label="Primary navigation">{navGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-label">{group.label}</div>{group.items.map(([label, id]) => <a className={page === id ? "nav-item active" : "nav-item"} href={`#${id}`} key={id} onClick={() => setMenuOpen(false)}><Icon name={id === "overview" ? "grid" : id === "projects" ? "folder" : id === "tasks" ? "check" : id === "notes" ? "note" : id === "github" ? "github" : id === "docker" ? "box" : id === "system" || id === "servers" ? "server" : "grid"} />{label}</a>)}</div>)}</nav><div className="sidebar-bottom"><a className={page === "settings" ? "nav-item active" : "nav-item"} href="#settings"><Icon name="settings" />Settings</a><button className="profile-row" onClick={() => notify("Profile controls are not connected yet.")}><span className="avatar">SK</span><span><strong>Skywalker</strong><small>Local workspace</small></span><span className="more">•••</span></button></div></aside>
      <div className="workspace"><header className="topbar"><div className="crumb"><button className="mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(!menuOpen)}>☰</button><span>Workspace</span><span className="crumb-separator">/</span><strong>{pageTitle.charAt(0).toUpperCase() + pageTitle.slice(1)}</strong></div><div className="top-actions"><button className="command-trigger" onClick={() => setPaletteOpen(true)}><span>Search commands</span><kbd>⌘ K</kbd></button><button className="icon-button" aria-label="View notifications" onClick={() => notify("No new notifications.")}>◌</button><button className="icon-button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setDark(!dark)}>{dark ? "☼" : "☾"}</button><button className="top-avatar" aria-label="Open profile" onClick={() => notify("Profile controls are not connected yet.")}>SK</button></div></header><main id="main-content" className="main-content">{page === "overview" ? <Overview go={go} /> : page === "projects" ? <ProjectWorkspaceList /> : page === "git" ? <GitWorkspace /> : page === "deployments" ? <DeploymentWorkspace /> : page === "github" || page === "repositories" || page === "pull-requests" || page === "issues" ? <GithubPhase2 page={page} tab={githubTab} setTab={setGithubTab} /> : page === "docker" ? <Docker /> : page === "system" || page === "servers" ? <System page={page} /> : <Placeholder page={pageTitle} />}</main></div>
    {notice && <div className="toast" role="status">{notice}</div>}{paletteOpen && <CommandPalette close={() => setPaletteOpen(false)} go={go} toggleTheme={() => setDark(!dark)} />}
  </div>;
}

function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) { return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="header-action">{action}</div>}</div>; }
function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) { return <div className="panel-header"><h2>{title}</h2>{action}</div>; }
function Summary({ title, value, detail, icon, link }: { title: string; value: string; detail: string; icon: string; link: string }) { return <a className="summary" href={link}><div className="summary-top"><span className="summary-icon"><Icon name={icon} /></span><span>{title}</span><span className="summary-arrow">↗</span></div><div className="summary-value">{value}</div><div className="summary-detail"><span className="status-dot status-green" />{detail}</div></a>; }

function Overview({ go }: { go: (page: string) => void }) {
  const [github, setGithub] = useState<GithubOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/github/overview", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw body; return body as GithubOverview; }).then((body) => { setGithub(body); setLoading(false); }).catch((reason: { message?: string }) => { setError(reason.message || "Connect GitHub to see repository activity."); setLoading(false); }); }, []);
  const activity = github?.activity.items || [];
  return <><PageHeader title="Overview" description="Your development workspace at a glance." /><div className="mock-note">Workspace services are shown with live GitHub data where connected.</div><section className="overview-grid" aria-label="Workspace summary"><Summary title="Projects" value="4" detail="2 active" icon="folder" link="#projects" /><Summary title="GitHub" value={loading ? "..." : github ? String(github.repositories.length) : "-"} detail={github ? `${github.pullRequests.totalCount} PRs, ${github.issues.totalCount} issues` : loading ? "Loading GitHub" : "Connect GitHub"} icon="github" link="#github" /><Summary title="Infrastructure" value="3" detail="2 running" icon="box" link="#docker" /></section><div className="content-grid"><section className="panel projects-panel"><PanelHeader title="Recent projects" action={<button className="text-button" onClick={() => go("projects")}>View all</button>} /><div className="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Stack</th><th>Last activity</th></tr></thead><tbody>{projects.map((project) => <tr key={project.name}><td className="strong-cell">{project.name}</td><td><Status tone={project.tone}>{project.status}</Status></td><td className="muted-cell">{project.framework}</td><td className="muted-cell">{project.updated}</td></tr>)}</tbody></table></div></section><section className="panel activity-panel"><PanelHeader title="Recent GitHub activity" />{loading && <div className="state-block"><strong>Loading activity</strong><span>Fetching recent GitHub events.</span></div>}{!loading && error && <div className="state-block"><strong>GitHub is not connected</strong><span>{error}</span><a className="text-button" href="#github">Open GitHub</a></div>}{!loading && !error && !activity.length && <div className="state-block"><strong>No recent GitHub activity</strong><span>New commits, pull requests, and issues will appear here.</span></div>}{!loading && !error && activity.length > 0 && <ul className="github-list activity-feed">{activity.map((item, index) => <li key={`${item.type}-${item.timestamp}-${index}`}><span className="activity-marker blue" /><div><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a><span>{item.action} · {item.type.replace("_", " ")} · {item.repository} · {item.actor}</span></div><time>{new Date(item.timestamp).toLocaleDateString()}</time></li>)}</ul>}</section></div><section className="panel system-panel"><PanelHeader title="System status" action={<button className="text-button" onClick={() => go("system")}>Open system</button>} /><div className="metric-row">{systemMetrics.slice(0, 5).map((metric) => <div className="metric" key={metric.label}><div><span>{metric.label}</span><strong>{metric.value}</strong></div><div className="meter"><span className={`meter-fill ${metric.tone}`} style={{ width: metric.width }} /></div><small>{metric.detail}</small></div>)}</div></section></>;
}

function Docker() { return <DockerPhase3 />; }
function System({ page }: { page: Page }) { return page === "system" ? <SystemWorkspace /> : <><PageHeader title="Servers" description="Local and connected server environments." /><section className="panel state-block"><strong>No connected servers</strong><span>Server details will appear here when an environment is configured.</span></section></>; }
function Placeholder({ page }: { page: string }) { return page === "terminal" ? <TerminalWorkspace /> : <><PageHeader title={page.charAt(0).toUpperCase() + page.slice(1)} description={`A focused space for ${page.toLowerCase()} in your workspace.`} /><section className="panel state-block"><strong>This view is ready for your data.</strong><span>Backend connections are intentionally out of scope for this frontend pass.</span></section></>; }
function CommandPalette({ close, go, toggleTheme }: { close: () => void; go: (page: string) => void; toggleTheme: () => void }) { const commands = [["Go to Overview", "overview"], ["Open Projects", "projects"], ["Open GitHub", "github"], ["Open Docker", "docker"], ["Open System", "system"], ["Search projects", "projects"]]; return <div className="palette-backdrop" role="presentation" onMouseDown={close}><section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(event) => event.stopPropagation()}><div className="palette-input"><span>⌕</span><input autoFocus placeholder="Type a command..." aria-label="Search commands" /></div><div className="command-list"><div className="command-group-label">Navigate</div>{commands.map(([label, destination], index) => <button className="command-item" key={`${destination}-${index}`} onClick={() => { go(destination); close(); }}><span>{label}</span><kbd>↵</kbd></button>)}<div className="command-group-label">Actions</div><button className="command-item" onClick={() => { toggleTheme(); close(); }}><span>Toggle theme</span><kbd>↵</kbd></button><button className="command-item" onClick={() => { go("settings"); close(); }}><span>Open Settings</span><kbd>↵</kbd></button></div><div className="palette-footer"><span>Esc to close</span><span>↑↓ to navigate</span></div></section></div>; }
