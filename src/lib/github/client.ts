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

// A transport failure has no HTTP status; routes must still return JSON rather than let it escape.
export function isGithubUnavailable(error: unknown) {
  return error instanceof GithubApiError && error.status === 0;
}

export async function githubFetch<T>(path: string, accessToken: string) {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
  } catch {
    throw new GithubApiError(0, "GitHub could not be reached. Check the network connection.");
  }

  const rateLimitReset = response.headers.get("x-ratelimit-reset") ?? undefined;
  const contentType = response.headers.get("content-type") || "";

  // An upstream 200 can still be an HTML interstitial from a proxy or CDN edge. Parsing it blindly
  // would throw a SyntaxError that escapes as an HTML error page from the route handler.
  if (!contentType.includes("json")) {
    throw new GithubApiError(response.ok ? 502 : response.status, `GitHub returned a non-JSON response (${contentType.split(";")[0] || "unknown content type"}).`, rateLimitReset);
  }

  let parsed: unknown;
  try { parsed = await response.json(); }
  catch { throw new GithubApiError(response.ok ? 502 : response.status, "GitHub returned an unreadable response.", rateLimitReset); }

  if (!response.ok) {
    const body = parsed as GithubErrorBody;
    throw new GithubApiError(response.status, typeof body?.message === "string" ? body.message : "GitHub returned an error.", rateLimitReset);
  }

  return parsed as T;
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
