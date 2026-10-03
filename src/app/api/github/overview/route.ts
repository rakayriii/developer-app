import { NextResponse } from "next/server";
import { getGithubAccount, getGithubRepositories } from "@/lib/github/client";
import { getGithubActivity } from "@/lib/github/activity";
import { getGithubIssues } from "@/lib/github/issues";
import { getGithubPullRequests } from "@/lib/github/pull-requests";
import { githubRouteError, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET() {
  const accessToken = await requireGithubToken();
  if (!accessToken) return unauthenticatedResponse();

  try {
    const account = await getGithubAccount(accessToken);
    const [repositories, pullRequests, issues, activity] = await Promise.all([
      getGithubRepositories(accessToken),
      getGithubPullRequests(accessToken, { account, page: 1, perPage: 5 }),
      getGithubIssues(accessToken, { account, page: 1, perPage: 5 }),
      getGithubActivity(accessToken, { account, limit: 8 }),
    ]);
    return NextResponse.json({ account, repositories, pullRequests, issues, activity });
  } catch (error) {
    return githubRouteError(error);
  }
}
