import { NextResponse } from "next/server";
import { getBranches } from "@/lib/git/branches";
import { gitErrorResponse, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await getBranches(repositoryRoot)); } catch (error) { return gitErrorResponse(error); } }
