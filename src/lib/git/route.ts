import { NextResponse } from "next/server";
import { requireGithubToken } from "@/lib/github/route";
import { GitValidationError, resolveRepository } from "./validation.ts";
import { GitError } from "./runner.ts";

export async function requireGitAuth() { return requireGithubToken(); }
export async function repositoryFrom(request: Request) { const value = new URL(request.url).searchParams.get("repository") || "."; return resolveRepository(value); }
export function gitErrorResponse(error: unknown) { if (error instanceof GitValidationError || error instanceof GitError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status }); return NextResponse.json({ code: "git_error", message: "Git operation failed." }, { status: 500 }); }
export function unauthenticatedGitResponse() { return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub to manage local repositories." }, { status: 401 }); }
export async function jsonBody(request: Request) { try { return await request.json() as Record<string, unknown>; } catch { throw new GitValidationError("invalid_body", "Request body must be valid JSON."); } }
export function stringValue(value: unknown, label: string) { if (typeof value !== "string") throw new GitValidationError("invalid_request", `${label} is required.`); return value; }
export function pathsValue(value: unknown) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new GitValidationError("invalid_paths", "paths must be an array of file paths."); return value as string[]; }
