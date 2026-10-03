import { getGithubAccount, githubFetch, type GithubAccount } from "@/lib/github/client";

export type GithubIssue = { id: number; number: number; title: string; repository: string; author: string; state: "open" | "closed"; labels: string[]; comments: number; createdAt: string; updatedAt: string; url: string };
type SearchItem = { id: number; number: number; title: string; repository_url: string; html_url: string; user: { login: string }; state: "open" | "closed"; labels: { name: string }[]; comments: number; created_at: string; updated_at: string; pull_request?: unknown };
type SearchResponse = { total_count: number; items: SearchItem[] };

export async function getGithubIssues(accessToken: string, options: { page: number; perPage: number; account?: GithubAccount }) {
  const account = options.account || await getGithubAccount(accessToken);
  const query = encodeURIComponent(`author:${account.login} is:issue`);
  const result = await githubFetch<SearchResponse>(`/search/issues?q=${query}&sort=updated&order=desc&page=${options.page}&per_page=${options.perPage}`, accessToken);
  const items = result.items.filter((item) => !item.pull_request).map((item) => {
    const parts = item.repository_url.split("/");
    return { id: item.id, number: item.number, title: item.title, repository: parts.at(-1) || "", author: item.user.login, state: item.state, labels: item.labels.map((label) => label.name), comments: item.comments, createdAt: item.created_at, updatedAt: item.updated_at, url: item.html_url };
  });
  return { items, totalCount: result.total_count, hasNextPage: options.page * options.perPage < result.total_count };
}
