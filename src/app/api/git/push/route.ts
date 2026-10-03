import { NextResponse } from "next/server";
import { pushRepository } from "@/lib/git/operations";
import { withGitMutation } from "@/lib/git/lock";
import { gitErrorResponse, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await withGitMutation(repositoryRoot, () => pushRepository(repositoryRoot))); } catch (error) { return gitErrorResponse(error); } }
