import { NextResponse } from "next/server";
import { getGithubPullRequests } from "@/lib/github/pull-requests";
import { githubRouteError, pagination, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  try { return NextResponse.json(await getGithubPullRequests(token, pagination(request))); } catch (error) { return githubRouteError(error); }
}
