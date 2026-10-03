import { NextResponse } from "next/server";
import { createCommit } from "@/lib/git/operations";
import { withGitMutation } from "@/lib/git/lock";
import { gitErrorResponse, jsonBody, repositoryFrom, requireGitAuth, stringValue, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const body = await jsonBody(request); const message = stringValue(body.message, "message"); const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await withGitMutation(repositoryRoot, () => createCommit(repositoryRoot, message))); } catch (error) { return gitErrorResponse(error); } }
