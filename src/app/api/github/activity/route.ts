import { NextResponse } from "next/server";
import { getGithubActivity } from "@/lib/github/activity";
import { githubRouteError, pagination, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  const { page, perPage } = pagination(request, 30);
  try { return NextResponse.json(await getGithubActivity(token, { limit: perPage, page, perPage })); } catch (error) { return githubRouteError(error); }
}
