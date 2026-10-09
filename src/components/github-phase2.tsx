"use client";

import { readApiJson } from "@/lib/api/client";

import { useEffect, useState } from "react";

type Account = { login: string; name: string | null; avatarUrl: string; htmlUrl: string };
type Repository = { id: number; name: string; owner: string; description: string | null; language: string | null; stars: number; forks: number; visibility: string; updatedAt: string; htmlUrl: string };
type PullRequest = { id: number; number: number; title: string; repository: string; owner: string; author: string; state: "open" | "closed"; draft: boolean; labels: string[]; createdAt: string; updatedAt: string; merged: boolean; url: string };
type Issue = { id: number; number: number; title: string; repository: string; author: string; state: "open" | "closed"; labels: string[]; comments: number; createdAt: string; updatedAt: string; url: string };
type Commit = { sha: string; message: string; repository: string; author: string; date: string; url: string };
type Activity = { type: string; action: string; repository: string; title: string; actor: string; timestamp: string; url: string };
type ErrorState = { code?: string; message?: string };
type GithubPayload = { account?: Account; repositories?: Repository[]; items?: unknown[]; activity?: Activity[] };

function date(value: string) {
  return value ? new Date(value).toLocaleDateString() : "-";
}

function labels(values: string[]) {
  return values.length ? values.join(", ") : "-";
}

function GitHubHeader({ account, disconnect }: { account: Account | null; disconnect: () => void }) {
  return <>
    <div className="page-header"><div><h1>GitHub</h1><p>A quiet view of your code activity.</p></div>{account && <button className="secondary-button" onClick={disconnect}>Disconnect</button>}</div>
    {account && <div className="github-account"><span className="github-avatar" role="img" aria-label={`${account.login} avatar`} style={{ backgroundImage: `url(${account.avatarUrl})` }} /><div><strong>{account.name || account.login}</strong><span>@{account.login}</span></div><a href={account.htmlUrl} target="_blank" rel="noreferrer">View profile</a></div>}
  </>;
}

export default function GithubPhase2({ page, tab, setTab }: { page: string; tab: string; setTab: (tab: string) => void }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorState | null>(null);
  const tabs = ["Repositories", "Pull Requests", "Issues", "Commits", "Activity"];
  const pageDefaultTab = page === "pull-requests" ? "Pull Requests" : page === "issues" ? "Issues" : page === "repositories" ? "Repositories" : "Repositories";
  const activeTab = page !== "github" && tab === "Repositories" ? pageDefaultTab : tab;
  const endpoint = activeTab === "Repositories" ? "/api/github/overview" : activeTab === "Pull Requests" ? "/api/github/pull-requests" : activeTab === "Issues" ? "/api/github/issues" : activeTab === "Commits" ? "/api/github/commits" : "/api/github/activity";

  useEffect(() => { if (page !== "github") setTab(activeTab); }, [activeTab, page, setTab]);

  useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { cache: "no-store" }).then(async (response) => { const result = await readApiJson<GithubPayload>(response); if (!result.ok) throw Object.assign(new Error(result.error.message), result.error); return result.data; }).then((body) => {
      if (cancelled) return;
      if (body.account) setAccount(body.account);
      if (activeTab === "Repositories") setRepositories(body.repositories || []);
      if (activeTab === "Pull Requests") setPullRequests((body.items || []) as PullRequest[]);
      if (activeTab === "Issues") setIssues((body.items || []) as Issue[]);
      if (activeTab === "Commits") setCommits((body.items || []) as Commit[]);
      if (activeTab === "Activity") setActivity((body.items || []) as Activity[]);
      setLoading(false);
    }).catch((reason: ErrorState) => { if (!cancelled) { setError(reason); setLoading(false); } });
    return () => { cancelled = true; };
  }, [activeTab, endpoint, tab]);

  const disconnect = async () => { await fetch("/api/auth/logout", { method: "POST" }); setAccount(null); setRepositories([]); setPullRequests([]); setIssues([]); setCommits([]); setActivity([]); setError({ code: "not_authenticated", message: "GitHub disconnected." }); };
  return <>
    <GitHubHeader account={account} disconnect={disconnect} />
    {/* A full navigation is required here: this endpoint starts the OAuth redirect. Client-side routing would request it as an RSC payload and never reach the provider. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    {!loading && error && <div className={`github-state ${error.code === "not_authenticated" ? "github-connect" : "github-error"}`} role="alert"><strong>{error.code === "not_authenticated" ? "Connect your GitHub account" : error.code === "rate_limited" ? "GitHub rate limit reached" : "GitHub connection problem"}</strong><span>{error.message || "GitHub could not be reached."}</span>{error.code === "not_authenticated" && <a className="primary-button" href="/api/auth/github">Connect GitHub</a>}</div>}
    {loading && <div className="panel state-block" role="status"><strong>Loading GitHub data</strong><span>Fetching this view securely.</span></div>}
    {!loading && !error && <><div className="tabs" role="tablist">{tabs.map((item) => <button role="tab" aria-selected={activeTab === item} className={activeTab === item ? "tab active" : "tab"} onClick={() => setTab(item)} key={item}>{item}</button>)}</div><section className="panel table-panel">{activeTab === "Repositories" && <RepositoryTable items={repositories} />}{activeTab === "Pull Requests" && <PullRequestTable items={pullRequests} />}{activeTab === "Issues" && <IssueTable items={issues} />}{activeTab === "Commits" && <CommitList items={commits} />}{activeTab === "Activity" && <ActivityList items={activity} />}</section></>}
    {!loading && !error && page !== "github" && <div className="context-note">Showing the {page.replace("-", " ")} view.</div>}
  </>;
}

function Empty({ label }: { label: string }) { return <div className="empty-state"><strong>No {label} found</strong><span>GitHub did not return any matching data for this connection.</span></div>; }
function RepositoryTable({ items }: { items: Repository[] }) { if (!items.length) return <Empty label="repositories" />; return <div className="table-wrap"><table><thead><tr><th>Repository</th><th>Description</th><th>Language</th><th>Stars</th><th>Forks</th><th>Visibility</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><a className="repo-link" href={`/github/repositories/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`}><strong>{item.owner}/{item.name}</strong></a></td><td className="description-cell">{item.description || "No description"}</td><td>{item.language || "-"}</td><td>{item.stars}</td><td>{item.forks}</td><td>{item.visibility}</td><td className="muted-cell">{date(item.updatedAt)}</td></tr>)}</tbody></table></div>; }
function PullRequestTable({ items }: { items: PullRequest[] }) { if (!items.length) return <Empty label="pull requests" />; return <div className="table-wrap"><table><thead><tr><th>Title</th><th>Repository</th><th>Author</th><th>State</th><th>Draft</th><th>Labels</th><th>Created</th><th>Updated</th><th>Merged</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a></td><td className="mono-cell">{item.owner}/{item.repository}</td><td>{item.author}</td><td><span className={`status status-${item.state === "open" ? "green" : "yellow"}`}><span className="status-dot" />{item.state}</span></td><td>{item.draft ? "Draft" : "Ready"}</td><td>{labels(item.labels)}</td><td className="muted-cell">{date(item.createdAt)}</td><td className="muted-cell">{date(item.updatedAt)}</td><td>{item.merged ? "Merged" : "-"}</td></tr>)}</tbody></table></div>; }
function IssueTable({ items }: { items: Issue[] }) { if (!items.length) return <Empty label="issues" />; return <div className="table-wrap"><table><thead><tr><th>Title</th><th>Repository</th><th>Author</th><th>State</th><th>Labels</th><th>Comments</th><th>Created</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a></td><td className="mono-cell">{item.repository}</td><td>{item.author}</td><td><span className={`status status-${item.state === "open" ? "green" : "yellow"}`}><span className="status-dot" />{item.state}</span></td><td>{labels(item.labels)}</td><td>{item.comments}</td><td className="muted-cell">{date(item.createdAt)}</td><td className="muted-cell">{date(item.updatedAt)}</td></tr>)}</tbody></table></div>; }
function CommitList({ items }: { items: Commit[] }) { if (!items.length) return <Empty label="commits" />; return <ul className="github-list">{items.map((item) => <li key={`${item.repository}-${item.sha}`}><div><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.message}</strong></a><span>{item.repository} · {item.author}</span></div><time>{date(item.date)}</time><code>{item.sha.slice(0, 7)}</code></li>)}</ul>; }
function ActivityList({ items, loading, error }: { items: Activity[]; loading?: boolean; error?: string }) { if (loading) return <div className="state-block"><strong>Loading activity</strong><span>Fetching recent GitHub events.</span></div>; if (error) return <div className="state-block"><strong>GitHub activity unavailable</strong><span>{error}</span><a className="text-button" href="#github">Open GitHub</a></div>; if (!items.length) return <div className="state-block"><strong>No recent GitHub activity</strong><span>New commits, pull requests, and issues will appear here.</span></div>; return <ul className="github-list activity-feed">{items.map((item, index) => <li key={`${item.type}-${item.timestamp}-${index}`}><span className="activity-marker blue" /><div><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a><span>{item.action} · {item.type.replace("_", " ")} · {item.repository} · {item.actor}</span></div><time>{date(item.timestamp)}</time></li>)}</ul>; }
