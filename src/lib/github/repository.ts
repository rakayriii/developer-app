import { githubFetch } from "@/lib/github/client";

export type RepositoryDetail = { id: number; name: string; owner: string; description: string | null; visibility: string; stars: number; forks: number; watchers: number; defaultBranch: string; language: string | null; topics: string[]; license: string | null; createdAt: string; updatedAt: string; pushedAt: string; url: string; homepage: string | null; openIssues: number };
export type RepositoryLanguage = { name: string; bytes: number; percentage: number };
export type RepositoryBranch = { name: string; sha: string; commitUrl: string };
export type RepositoryCommit = { sha: string; message: string; author: string; date: string; url: string };
export type RepositoryPullRequest = { id: number; title: string; author: string; state: "open" | "closed"; draft: boolean; labels: string[]; createdAt: string; updatedAt: string; url: string };
export type RepositoryIssue = { id: number; title: string; author: string; state: "open" | "closed"; labels: string[]; comments: number; createdAt: string; updatedAt: string; url: string };

type RepositoryResponse = { id: number; name: string; owner: { login: string }; description: string | null; visibility: string; stargazers_count: number; forks_count: number; watchers_count: number; default_branch: string; language: string | null; topics?: string[]; license: { spdx_id: string | null; name: string } | null; created_at: string; updated_at: string; pushed_at: string; html_url: string; homepage: string | null; open_issues_count: number };
type LanguageResponse = Record<string, number>;
type BranchResponse = { name: string; commit: { sha: string; url: string } };
type CommitResponse = { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null }; author: { login: string } | null };
type PullResponse = { id: number; title: string; user: { login: string }; state: "open" | "closed"; draft: boolean | null; labels: { name: string }[]; created_at: string; updated_at: string; html_url: string };
type IssueResponse = { id: number; title: string; user: { login: string }; state: "open" | "closed"; labels: { name: string }[]; comments: number; created_at: string; updated_at: string; html_url: string; pull_request?: unknown };

export function validRepositoryPart(value: string) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98})$/.test(value);
}

function base(owner: string, repo: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function getRepositoryDetail(token: string, owner: string, repo: string) {
  const [repository, languages] = await Promise.all([githubFetch<RepositoryResponse>(base(owner, repo), token), githubFetch<LanguageResponse>(`${base(owner, repo)}/languages`, token)]);
  const totalBytes = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
  return {
    repository: { id: repository.id, name: repository.name, owner: repository.owner.login, description: repository.description, visibility: repository.visibility, stars: repository.stargazers_count, forks: repository.forks_count, watchers: repository.watchers_count, defaultBranch: repository.default_branch, language: repository.language, topics: repository.topics || [], license: repository.license?.spdx_id || repository.license?.name || null, createdAt: repository.created_at, updatedAt: repository.updated_at, pushedAt: repository.pushed_at, url: repository.html_url, homepage: repository.homepage, openIssues: repository.open_issues_count } satisfies RepositoryDetail,
    languages: Object.entries(languages).map(([name, bytes]) => ({ name, bytes, percentage: totalBytes ? Number(((bytes / totalBytes) * 100).toFixed(1)) : 0 })).sort((a, b) => b.bytes - a.bytes),
  };
}

export async function getRepositoryBranches(token: string, owner: string, repo: string, page: number, perPage: number) {
  const values = await githubFetch<BranchResponse[]>(`${base(owner, repo)}/branches?protected=false&page=${page}&per_page=${perPage}`, token);
  return { items: values.map((branch) => ({ name: branch.name, sha: branch.commit.sha, commitUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commit/${branch.commit.sha}` })), hasNextPage: values.length === perPage } as { items: RepositoryBranch[]; hasNextPage: boolean };
}

export async function getRepositoryCommits(token: string, owner: string, repo: string, page: number, perPage: number) {
  const values = await githubFetch<CommitResponse[]>(`${base(owner, repo)}/commits?page=${page}&per_page=${perPage}`, token);
  return { items: values.map((commit) => ({ sha: commit.sha, message: commit.commit.message.split("\n")[0], author: commit.author?.login || commit.commit.author?.name || "Unknown author", date: commit.commit.author?.date || "", url: commit.html_url })), hasNextPage: values.length === perPage } as { items: RepositoryCommit[]; hasNextPage: boolean };
}

export async function getRepositoryPullRequests(token: string, owner: string, repo: string, page: number, perPage: number) {
  const values = await githubFetch<PullResponse[]>(`${base(owner, repo)}/pulls?state=all&sort=updated&direction=desc&page=${page}&per_page=${perPage}`, token);
  return { items: values.map((item) => ({ id: item.id, title: item.title, author: item.user.login, state: item.state, draft: Boolean(item.draft), labels: item.labels.map((label) => label.name), createdAt: item.created_at, updatedAt: item.updated_at, url: item.html_url })), hasNextPage: values.length === perPage } as { items: RepositoryPullRequest[]; hasNextPage: boolean };
}

export async function getRepositoryIssues(token: string, owner: string, repo: string, page: number, perPage: number) {
  const values = await githubFetch<IssueResponse[]>(`${base(owner, repo)}/issues?state=all&sort=updated&direction=desc&page=${page}&per_page=${perPage}`, token);
  return { items: values.filter((item) => !item.pull_request).map((item) => ({ id: item.id, title: item.title, author: item.user.login, state: item.state, labels: item.labels.map((label) => label.name), comments: item.comments, createdAt: item.created_at, updatedAt: item.updated_at, url: item.html_url })), hasNextPage: values.length === perPage } as { items: RepositoryIssue[]; hasNextPage: boolean };
}
