import { NextResponse } from "next/server";
import { getRepositoryPullRequests, validRepositoryPart } from "@/lib/github/repository";
import { githubRouteError, pagination, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  const { owner, repo } = await params;
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo)) return NextResponse.json({ code: "invalid_repository", message: "The repository owner or name is invalid." }, { status: 400 });
  const { page, perPage } = pagination(request, 10);
  try { return NextResponse.json(await getRepositoryPullRequests(token, owner, repo, page, Math.min(perPage, 20))); } catch (error) { return githubRouteError(error); }
}
