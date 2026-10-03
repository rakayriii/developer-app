import { NextResponse } from "next/server";
import { getGithubIssues } from "@/lib/github/issues";
import { githubRouteError, pagination, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  try { return NextResponse.json(await getGithubIssues(token, pagination(request))); } catch (error) { return githubRouteError(error); }
}
