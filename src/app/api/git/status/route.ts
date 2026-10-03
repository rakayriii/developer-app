import { NextResponse } from "next/server";
import { getGitStatus } from "@/lib/git/status";
import { gitErrorResponse, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await getGitStatus(repositoryRoot)); } catch (error) { return gitErrorResponse(error); } }
