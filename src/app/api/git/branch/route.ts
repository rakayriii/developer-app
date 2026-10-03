import { NextResponse } from "next/server";
import { createBranch } from "@/lib/git/operations";
import { withGitMutation } from "@/lib/git/lock";
import { gitErrorResponse, jsonBody, repositoryFrom, requireGitAuth, stringValue, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const body = await jsonBody(request); const name = stringValue(body.name, "name"); const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json({ name: await withGitMutation(repositoryRoot, () => createBranch(repositoryRoot, name)) }, { status: 201 }); } catch (error) { return gitErrorResponse(error); } }
