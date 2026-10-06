import { NextResponse } from "next/server";
import { GithubApiError } from "@/lib/github/client";
import { clearGithubSession } from "@/lib/github/session";
import { apiErrorResponse } from "@/lib/api/errors";

export function projectError(error: unknown) {
  if (error instanceof GithubApiError) {
    if (error.status === 401) { const response = NextResponse.json({ code: "auth_expired", message: "Your GitHub connection expired." }, { status: 401 }); clearGithubSession(response); return response; }
    if (error.status === 403) return NextResponse.json({ code: "rate_limited", message: "GitHub rate limit reached. Try again later." }, { status: 429 });
    if (error.status === 404) return NextResponse.json({ code: "github_not_found", message: "The GitHub repository was not found or is not accessible." }, { status: 404 });
  }
  return apiErrorResponse(error, { code: "project_error", message: "The project could not be loaded." });
}
