import { NextResponse } from "next/server";
import { checkoutBranch } from "@/lib/git/operations";
import { withGitMutation } from "@/lib/git/lock";
import { gitErrorResponse, jsonBody, repositoryFrom, requireGitAuth, stringValue, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function POST(request: Request) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); try { const body = await jsonBody(request); const name = stringValue(body.name, "name"); const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await withGitMutation(repositoryRoot, () => checkoutBranch(repositoryRoot, name))); } catch (error) { return gitErrorResponse(error); } }
