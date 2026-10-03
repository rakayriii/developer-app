export type GithubAccount = {
  login: string;
  name: string | null;
  avatarUrl: string;
  htmlUrl: string;
};

export type GithubRepository = {
  id: number;
  name: string;
  owner: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  visibility: string;
  updatedAt: string;
  htmlUrl: string;
};

type GithubErrorBody = { message?: string; documentation_url?: string };

export class GithubApiError extends Error {
  constructor(public status: number, message: string, public rateLimitReset?: string) {
    super(message);
    this.name = "GithubApiError";
  }
}

export async function githubFetch<T>(path: string, accessToken: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as GithubErrorBody;
    throw new GithubApiError(response.status, body.message || "GitHub returned an error.", response.headers.get("x-ratelimit-reset") ?? undefined);
  }

  return response.json() as Promise<T>;
}

type GithubUserResponse = { login: string; name: string | null; avatar_url: string; html_url: string };
type GithubRepositoryResponse = { id: number; name: string; owner: { login: string }; description: string | null; language: string | null; stargazers_count: number; forks_count: number; visibility: string; updated_at: string; html_url: string };

export async function getGithubAccount(accessToken: string): Promise<GithubAccount> {
  const user = await githubFetch<GithubUserResponse>("/user", accessToken);
  return { login: user.login, name: user.name, avatarUrl: user.avatar_url, htmlUrl: user.html_url };
}

export async function getGithubRepositories(accessToken: string): Promise<GithubRepository[]> {
  const repositories = await githubFetch<GithubRepositoryResponse[]>("/user/repos?sort=updated&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member", accessToken);
  return repositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    owner: repository.owner.login,
    description: repository.description,
    language: repository.language,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    visibility: repository.visibility,
    updatedAt: repository.updated_at,
    htmlUrl: repository.html_url,
  }));
}
