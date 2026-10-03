import { cookieValue, decryptGithubSession, githubSessionCookie } from "../src/lib/github/session-core.mjs";

export async function authenticateTerminalRequest(request) {
  const encrypted = cookieValue(request.headers.cookie, githubSessionCookie);
  const accessToken = decryptGithubSession(encrypted);
  if (!accessToken) return null;
  const response = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "X-GitHub-Api-Version": "2022-11-28" }, cache: "no-store" });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user.login === "string" ? user.login : null;
}
