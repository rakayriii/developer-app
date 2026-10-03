import { getGithubAccount, githubFetch, type GithubAccount } from "@/lib/github/client";

export type GithubPullRequest = {
  id: number;
  number: number;
  title: string;
  repository: string;
  owner: string;
  author: string;
  state: "open" | "closed";
  draft: boolean;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  url: string;
};

type SearchItem = { id: number; number: number; title: string; repository_url: string; html_url: string; user: { login: string }; state: "open" | "closed"; draft: boolean | null; labels: { name: string }[]; created_at: string; updated_at: string; pull_request?: { url: string } };
type SearchResponse = { total_count: number; items: SearchItem[] };
type PullRequestDetail = { merged_at: string | null };

function repositoryParts(repositoryUrl: string) {
  const parts = repositoryUrl.split("/");
  return { owner: parts.at(-2) || "", repository: parts.at(-1) || "" };
}

export async function getGithubPullRequests(accessToken: string, options: { page: number; perPage: number; account?: GithubAccount }) {
  const account = options.account || await getGithubAccount(accessToken);
  const query = encodeURIComponent(`author:${account.login} is:pr`);
  const result = await githubFetch<SearchResponse>(`/search/issues?q=${query}&sort=updated&order=desc&page=${options.page}&per_page=${options.perPage}`, accessToken);
  const closedItems = result.items.filter((item) => item.state === "closed").slice(0, 20);
  const mergedById = new Map<number, boolean>();
  await Promise.all(closedItems.map(async (item) => {
    const parts = repositoryParts(item.repository_url);
    if (!parts.owner || !parts.repository) return;
    const detail = await githubFetch<PullRequestDetail>(`/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repository)}/pulls/${item.number}`, accessToken);
    mergedById.set(item.id, Boolean(detail.merged_at));
  }));

  return {
    items: result.items.map((item) => {
      const parts = repositoryParts(item.repository_url);
      return { id: item.id, number: item.number, title: item.title, repository: parts.repository, owner: parts.owner, author: item.user.login, state: item.state, draft: Boolean(item.draft), labels: item.labels.map((label) => label.name), createdAt: item.created_at, updatedAt: item.updated_at, merged: mergedById.get(item.id) || false, url: item.html_url };
    }),
    totalCount: result.total_count,
    hasNextPage: options.page * options.perPage < result.total_count,
  };
}
