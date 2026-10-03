import { getGithubAccount } from "@/lib/github/client";
import { getGithubAccessToken } from "@/lib/github/session";
import { prisma } from "@/lib/db";

export async function getProjectIdentity() {
  const accessToken = await getGithubAccessToken();
  if (!accessToken) return null;
  const account = await getGithubAccount(accessToken);
  const user = await prisma.user.upsert({ where: { githubLogin: account.login }, update: {}, create: { githubLogin: account.login } });
  return { accessToken, githubLogin: account.login, userId: user.id };
}
