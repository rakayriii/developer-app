"use client";

import { useEffect, useState } from "react";
import GithubPhase2 from "@/components/github-phase2";
import DockerPhase3 from "@/components/docker-phase3";
import ProjectWorkspaceList from "@/components/project-workspace";
import TerminalWorkspace from "@/components/terminal-workspace";
import SystemWorkspace from "@/components/system-workspace";
import GitWorkspace from "@/components/git-workspace";
import DeploymentWorkspace from "@/components/deployment-workspace";
import { Icon, navigateToWorkspace } from "@/components/app-shell";
import { readApiJson } from "@/lib/api/client";
import { projects, systemMetrics } from "@/data/mock-data";

type Page = "overview" | "projects" | "terminal" | "git" | "deployments" | "tasks" | "notes" | "github" | "repositories" | "pull-requests" | "issues" | "docker" | "servers" | "system" | "settings";
type GithubAccount = { login: string; name: string | null; avatarUrl: string; htmlUrl: string };
type GithubRepository = { id: number; name: string; owner: string; description: string | null; language: string | null; stars: number; forks: number; visibility: string; updatedAt: string; htmlUrl: string };
type GithubActivity = { type: string; action: string; repository: string; title: string; actor: string; timestamp: string; url: string };
type GithubOverview = { account: GithubAccount; repositories: GithubRepository[]; pullRequests: { totalCount: number }; issues: { totalCount: number }; activity: { items: GithubActivity[] } };

function Status({ tone, children }: { tone: string; children: React.ReactNode }) { return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>; }

export default function DeveloperOS() {
  const [page, setPage] = useState<Page>("overview");
  const [githubTab, setGithubTab] = useState("Repositories");
  useEffect(() => {
    const sync = () => setPage((window.location.hash.slice(1) || "overview") as Page);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  // The same resolver the sidebar and the palette use, so a quick link lands where its nav item would.
  const go = (destination: string) => navigateToWorkspace(destination);
  const pageTitle = page === "pull-requests" ? "Pull Requests" : page.replace("-", " ");
  const content = page === "overview" ? <Overview go={go} /> : page === "projects" ? <ProjectWorkspaceList /> : page === "git" ? <GitWorkspace /> : page === "deployments" ? <DeploymentWorkspace /> : page === "github" || page === "repositories" || page === "pull-requests" || page === "issues" ? <GithubPhase2 page={page} tab={githubTab} setTab={setGithubTab} /> : page === "docker" ? <Docker /> : page === "system" || page === "servers" ? <System page={page} /> : <Placeholder page={pageTitle} />;
  return <>{content}</>;
}

function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) { return <div className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="header-action">{action}</div>}</div>; }
function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) { return <div className="panel-header"><h2>{title}</h2>{action}</div>; }
function Summary({ title, value, detail, icon, link }: { title: string; value: string; detail: string; icon: string; link: string }) { return <a className="summary" href={link}><div className="summary-top"><span className="summary-icon"><Icon name={icon} /></span><span>{title}</span><span className="summary-arrow">↗</span></div><div className="summary-value">{value}</div><div className="summary-detail"><span className="status-dot status-green" />{detail}</div></a>; }

function Overview({ go }: { go: (page: string) => void }) {
  const [github, setGithub] = useState<GithubOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/github/overview", { cache: "no-store" }).then(async (response) => { const result = await readApiJson<GithubOverview>(response); if (!result.ok) throw Object.assign(new Error(result.error.message), result.error); return result.data; }).then((body) => { setGithub(body); setLoading(false); }).catch((reason: { message?: string }) => { setError(reason.message || "Connect GitHub to see repository activity."); setLoading(false); }); }, []);
  const activity = github?.activity.items || [];
  return <><PageHeader title="Overview" description="Your development workspace at a glance." /><div className="mock-note">Workspace services are shown with live GitHub data where connected.</div><section className="overview-grid" aria-label="Workspace summary"><Summary title="Projects" value="4" detail="2 active" icon="folder" link="#projects" /><Summary title="GitHub" value={loading ? "..." : github ? String(github.repositories.length) : "-"} detail={github ? `${github.pullRequests.totalCount} PRs, ${github.issues.totalCount} issues` : loading ? "Loading GitHub" : "Connect GitHub"} icon="github" link="#github" /><Summary title="Infrastructure" value="3" detail="2 running" icon="box" link="#docker" /></section><div className="content-grid"><section className="panel projects-panel"><PanelHeader title="Recent projects" action={<button className="text-button" onClick={() => go("projects")}>View all</button>} /><div className="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Stack</th><th>Last activity</th></tr></thead><tbody>{projects.map((project) => <tr key={project.name}><td className="strong-cell">{project.name}</td><td><Status tone={project.tone}>{project.status}</Status></td><td className="muted-cell">{project.framework}</td><td className="muted-cell">{project.updated}</td></tr>)}</tbody></table></div></section><section className="panel activity-panel"><PanelHeader title="Recent GitHub activity" />{loading && <div className="state-block"><strong>Loading activity</strong><span>Fetching recent GitHub events.</span></div>}{!loading && error && <div className="state-block"><strong>GitHub is not connected</strong><span>{error}</span><a className="text-button" href="#github">Open GitHub</a></div>}{!loading && !error && !activity.length && <div className="state-block"><strong>No recent GitHub activity</strong><span>New commits, pull requests, and issues will appear here.</span></div>}{!loading && !error && activity.length > 0 && <ul className="github-list activity-feed">{activity.map((item, index) => <li key={`${item.type}-${item.timestamp}-${index}`}><span className="activity-marker blue" /><div><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a><span>{item.action} · {item.type.replace("_", " ")} · {item.repository} · {item.actor}</span></div><time>{new Date(item.timestamp).toLocaleDateString()}</time></li>)}</ul>}</section></div><section className="panel system-panel"><PanelHeader title="System status" action={<button className="text-button" onClick={() => go("system")}>Open system</button>} /><div className="metric-row">{systemMetrics.slice(0, 5).map((metric) => <div className="metric" key={metric.label}><div><span>{metric.label}</span><strong>{metric.value}</strong></div><div className="meter"><span className={`meter-fill ${metric.tone}`} style={{ width: metric.width }} /></div><small>{metric.detail}</small></div>)}</div></section></>;
}

function Docker() { return <DockerPhase3 />; }
function System({ page }: { page: Page }) { return page === "system" ? <SystemWorkspace /> : <><PageHeader title="Servers" description="Local and connected server environments." /><section className="panel state-block"><strong>No connected servers</strong><span>Server details will appear here when an environment is configured.</span></section></>; }
function Placeholder({ page }: { page: string }) { return page === "terminal" ? <TerminalWorkspace /> : <><PageHeader title={page.charAt(0).toUpperCase() + page.slice(1)} description={`A focused space for ${page.toLowerCase()} in your workspace.`} /><section className="panel state-block"><strong>This view is ready for your data.</strong><span>Backend connections are intentionally out of scope for this frontend pass.</span></section></>; }
