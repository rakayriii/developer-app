import { NextRequest, NextResponse } from "next/server";
import { getGitLog } from "@/lib/git/log";
import { gitErrorResponse, repositoryFrom, requireGitAuth, unauthenticatedGitResponse } from "@/lib/git/route";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) { if (!await requireGitAuth()) return unauthenticatedGitResponse(); const raw = request.nextUrl.searchParams.get("limit") || "50"; if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) return NextResponse.json({ code: "invalid_limit", message: "limit must be between 1 and 100." }, { status: 400 }); try { const { repositoryRoot } = await repositoryFrom(request); return NextResponse.json(await getGitLog(repositoryRoot, Number(raw))); } catch (error) { return gitErrorResponse(error); } }
