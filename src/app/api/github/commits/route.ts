import { NextResponse } from "next/server";
import { getGithubCommits } from "@/lib/github/commits";
import { githubRouteError, pagination, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  try { return NextResponse.json(await getGithubCommits(token, pagination(request, 15))); } catch (error) { return githubRouteError(error); }
}
