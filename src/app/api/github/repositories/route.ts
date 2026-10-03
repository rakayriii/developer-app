import { NextResponse } from "next/server";
import { getGithubRepositories } from "@/lib/github/client";
import { githubRouteError, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET() {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  try { return NextResponse.json({ items: await getGithubRepositories(token) }); } catch (error) { return githubRouteError(error); }
}
