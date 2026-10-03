import { NextRequest, NextResponse } from "next/server";
import { getGitDiff } from "@/lib/git/diff";
import { gitErrorResponse, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); const value = request.nextUrl.searchParams.get("staged") || "false"; if (value !== "true" && value !== "false") return NextResponse.json({ code: "invalid_staged", message: "staged must be true or false." }, { status: 400 }); try { const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await getGitDiff(repositoryRoot, value === "true")); } catch (error) { return gitErrorResponse(error); } }
