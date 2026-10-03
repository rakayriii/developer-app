"use client";
/* eslint-disable @next/next/no-html-link-for-pages */
/* The main repository shell is a client-rendered view; its root back link remains a real app destination. */

import { useEffect, useState } from "react";
import Link from "next/link";

type Detail = { id: number; name: string; owner: string; description: string | null; visibility: string; stars: number; forks: number; watchers: number; defaultBranch: string; language: string | null; topics: string[]; license: string | null; createdAt: string; updatedAt: string; pushedAt: string; url: string; homepage: string | null; openIssues: number };
type Language = { name: string; bytes: number; percentage: number };
type Branch = { name: string; sha: string; commitUrl: string };
type Commit = { sha: string; message: string; author: string; date: string; url: string };
type PullRequest = { id: number; title: string; author: string; state: "open" | "closed"; draft: boolean; labels: string[]; createdAt: string; updatedAt: string; url: string };
type Issue = { id: number; title: string; author: string; state: "open" | "closed"; labels: string[]; comments: number; createdAt: string; updatedAt: string; url: string };
type ErrorState = { code?: string; message?: string };

const formatDate = (value: string) => value ? new Date(value).toLocaleDateString() : "-";
const repoPath = (owner: string, repo: string) => `/api/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

export default function GithubRepositoryDetail({ owner, repo }: { owner: string; repo: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [tab, setTab] = useState("Overview");
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetch(repoPath(owner, repo), { cache: "no-store" }), fetch(`${repoPath(owner, repo)}/branches?per_page=10`, { cache: "no-store" })]).then(async ([detailResponse, branchesResponse]) => {
      const detailBody = await detailResponse.json();
      const branchBody = await branchesResponse.json();
      if (!detailResponse.ok) throw detailBody;
      if (!branchesResponse.ok) throw branchBody;
      if (!cancelled) { setDetail(detailBody.repository); setLanguages(detailBody.languages || []); setBranches(branchBody.items || []); setLoading(false); }
    }).catch((reason: ErrorState) => { if (!cancelled) { setError(reason); setLoading(false); } });
    return () => { cancelled = true; };
  }, [owner, repo]);

  useEffect(() => {
    if (!detail || tab === "Overview") return;
    const endpoint = tab === "Commits" ? "commits" : tab === "Pull Requests" ? "pull-requests" : tab.toLowerCase();
    let cancelled = false;
    fetch(`${repoPath(owner, repo)}/${endpoint}?per_page=10`, { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw body; return body; }).then((body) => { if (cancelled) return; if (tab === "Commits") setCommits(body.items || []); if (tab === "Pull Requests") setPullRequests(body.items || []); if (tab === "Issues") setIssues(body.items || []); setTabLoading(false); }).catch((reason: ErrorState) => { if (!cancelled) { setError(reason); setTabLoading(false); } });
    return () => { cancelled = true; };
  }, [detail, owner, repo, tab]);

  if (loading) return <main className="repository-detail"><Link className="back-link" href="/">← Back to Developer OS</Link><div className="panel state-block" role="status"><strong>Loading repository</strong><span>Fetching repository details securely.</span></div></main>;
  if (error || !detail) return <main className="repository-detail"><Link className="back-link" href="/">← Back to Developer OS</Link><div className="github-state github-error" role="alert"><strong>{error?.code === "not_authenticated" ? "Connect GitHub to view this repository" : "Repository unavailable"}</strong><span>{error?.message || "GitHub did not return this repository."}</span>{error?.code === "not_authenticated" && <a className="primary-button" href="/api/auth/github">Connect GitHub</a>}</div></main>;

  const tabs = ["Overview", "Commits", "Pull Requests", "Issues", "Branches"];
  return <main className="repository-detail"><a className="back-link" href="/">← Back to Developer OS</a><header className="repository-header"><div><div className="repository-kicker">{detail.owner} / {detail.visibility}</div><h1>{detail.name}</h1><p>{detail.description || "No description provided."}</p></div><a className="secondary-button external-button" href={detail.url} target="_blank" rel="noreferrer">Open on GitHub</a></header><div className="repository-meta"><span>{detail.owner}</span><span>{detail.defaultBranch}</span><span>{detail.language || "Language not specified"}</span>{detail.license && <span>{detail.license}</span>}</div><section className="overview-grid repository-stats"><Stat label="Stars" value={detail.stars} /><Stat label="Forks" value={detail.forks} /><Stat label="Open issues" value={detail.openIssues} /><Stat label="Watchers" value={detail.watchers} /></section><div className="tabs" role="tablist">{tabs.map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "tab active" : "tab"} onClick={() => setTab(item)} key={item}>{item}</button>)}</div>{tabLoading && <div className="panel state-block" role="status"><strong>Loading {tab.toLowerCase()}</strong><span>Fetching the latest repository data.</span></div>}{!tabLoading && tab === "Overview" && <OverviewPanel detail={detail} languages={languages} branches={branches} />}{!tabLoading && tab === "Commits" && <CommitPanel items={commits} />}{!tabLoading && tab === "Pull Requests" && <PullRequestPanel items={pullRequests} />}{!tabLoading && tab === "Issues" && <IssuePanel items={issues} />}{!tabLoading && tab === "Branches" && <BranchPanel items={branches} />}</main>;
}

function Stat({ label, value }: { label: string; value: number }) { return <div className="summary"><div className="summary-top"><span>{label}</span></div><div className="summary-value">{value}</div></div>; }
function OverviewPanel({ detail, languages, branches }: { detail: Detail; languages: Language[]; branches: Branch[] }) { return <div className="repository-overview"><section className="panel detail-section"><div className="panel-header"><h2>Languages</h2></div>{languages.length ? languages.map((language) => <div className="language-row" key={language.name}><div><span>{language.name}</span><strong>{language.percentage}%</strong></div><div className="meter"><span className="meter-fill blue" style={{ width: `${language.percentage}%` }} /></div></div>) : <div className="state-block"><span>Language data is not available.</span></div>}</section><section className="panel detail-section"><div className="panel-header"><h2>Repository details</h2></div><dl className="detail-list"><div><dt>Created</dt><dd>{formatDate(detail.createdAt)}</dd></div><div><dt>Updated</dt><dd>{formatDate(detail.updatedAt)}</dd></div><div><dt>Last push</dt><dd>{formatDate(detail.pushedAt)}</dd></div><div><dt>Homepage</dt><dd>{detail.homepage ? <a href={detail.homepage} target="_blank" rel="noreferrer">{detail.homepage}</a> : "-"}</dd></div><div><dt>Topics</dt><dd>{detail.topics.length ? detail.topics.join(", ") : "-"}</dd></div></dl></section><section className="panel detail-section"><div className="panel-header"><h2>Recent branches</h2></div><BranchPanel items={branches.slice(0, 5)} /></section></div>; }
function EmptyDetail({ label }: { label: string }) { return <div className="state-block"><strong>No {label} found</strong><span>This repository has no matching data.</span></div>; }
function CommitPanel({ items }: { items: Commit[] }) { if (!items.length) return <section className="panel"><EmptyDetail label="recent commits" /></section>; return <section className="panel"><ul className="github-list">{items.map((item) => <li key={item.sha}><div><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.message}</strong></a><span>{item.author} · {formatDate(item.date)}</span></div><code>{item.sha.slice(0, 7)}</code></li>)}</ul></section>; }
function PullRequestPanel({ items }: { items: PullRequest[] }) { if (!items.length) return <section className="panel"><EmptyDetail label="pull requests" /></section>; return <section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Title</th><th>Author</th><th>State</th><th>Draft</th><th>Labels</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a></td><td>{item.author}</td><td>{item.state}</td><td>{item.draft ? "Draft" : "Ready"}</td><td>{item.labels.join(", ") || "-"}</td><td className="muted-cell">{formatDate(item.updatedAt)}</td></tr>)}</tbody></table></div></section>; }
function IssuePanel({ items }: { items: Issue[] }) { if (!items.length) return <section className="panel"><EmptyDetail label="issues" /></section>; return <section className="panel table-panel"><div className="table-wrap"><table><thead><tr><th>Title</th><th>Author</th><th>State</th><th>Labels</th><th>Comments</th><th>Updated</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><a className="repo-link" href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong></a></td><td>{item.author}</td><td>{item.state}</td><td>{item.labels.join(", ") || "-"}</td><td>{item.comments}</td><td className="muted-cell">{formatDate(item.updatedAt)}</td></tr>)}</tbody></table></div></section>; }
function BranchPanel({ items }: { items: Branch[] }) { if (!items.length) return <EmptyDetail label="branches" />; return <ul className="github-list branch-list">{items.map((item) => <li key={item.name}><div><strong>{item.name}</strong><span>{item.sha.slice(0, 7)}</span></div><a className="repo-link" href={item.commitUrl} target="_blank" rel="noreferrer">Last commit</a></li>)}</ul>; }
