import { getGithubRepositories, githubFetch, type GithubRepository } from "@/lib/github/client";

export type GithubCommit = { sha: string; message: string; repository: string; author: string; date: string; url: string };
type CommitResponse = { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } | null }; author: { login: string } | null };

export async function getGithubCommits(accessToken: string, options: { page: number; perPage: number }) {
  const repositories = await getGithubRepositories(accessToken);
  const repoLimit = Math.min(8, repositories.length);
  const start = (options.page - 1) * repoLimit;
  const selectedRepositories = repositories.slice(start, start + repoLimit);
  const perRepository = Math.min(options.perPage, 5);
  const results = await Promise.all(selectedRepositories.map(async (repository: GithubRepository) => {
    const commits = await githubFetch<CommitResponse[]>(`/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/commits?per_page=${perRepository}`, accessToken);
    return commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message.split("\n")[0], repository: repository.name, author: commit.author?.login || commit.commit.author?.name || "Unknown author", date: commit.commit.author?.date || "", url: commit.html_url }));
  }));
  const items = results.flat().filter((commit) => commit.date).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, options.perPage);
  return { items, hasNextPage: start + repoLimit < repositories.length };
}
