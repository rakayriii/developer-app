import { NextResponse } from "next/server";
import { unstageFiles } from "@/lib/git/operations";
import { withGitMutation } from "@/lib/git/lock";
import { gitErrorResponse, jsonBody, pathsValue, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const body = await jsonBody(request); const paths = pathsValue(body.paths); const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await withGitMutation(repositoryRoot, () => unstageFiles(repositoryRoot, paths))); } catch (error) { return gitErrorResponse(error); } }
