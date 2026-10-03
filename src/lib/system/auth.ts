import { requireGithubToken } from "@/lib/github/route";

export async function requireSystemAuth() {
  const token = await requireGithubToken();
  return token ? { authenticated: true as const } : null;
}
