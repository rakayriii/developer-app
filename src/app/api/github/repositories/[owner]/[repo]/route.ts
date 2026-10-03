import { NextResponse } from "next/server";
import { getRepositoryDetail, validRepositoryPart } from "@/lib/github/repository";
import { githubRouteError, requireGithubToken, unauthenticatedResponse } from "@/lib/github/route";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ owner: string; repo: string }> }) {
  const token = await requireGithubToken();
  if (!token) return unauthenticatedResponse();
  const { owner, repo } = await params;
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo)) return NextResponse.json({ code: "invalid_repository", message: "The repository owner or name is invalid." }, { status: 400 });
  try { return NextResponse.json(await getRepositoryDetail(token, owner, repo)); } catch (error) { return githubRouteError(error); }
}
