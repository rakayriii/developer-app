import { NextResponse } from "next/server";
import { GithubApiError } from "@/lib/github/client";
import { clearGithubSession, getGithubAccessToken } from "@/lib/github/session";
import { apiErrorResponse } from "@/lib/api/errors";

export async function requireGithubToken() {
  return getGithubAccessToken();
}

export function pagination(request: Request, defaultPerPage = 20) {
  const params = new URL(request.url).searchParams;
  const pageValue = Number(params.get("page") || "1");
  const perPageValue = Number(params.get("per_page") || String(defaultPerPage));
  return {
    page: Number.isInteger(pageValue) ? Math.min(Math.max(pageValue, 1), 10) : 1,
    perPage: Number.isInteger(perPageValue) ? Math.min(Math.max(perPageValue, 1), 30) : defaultPerPage,
  };
}

export function githubRouteError(error: unknown) {
  if (!(error instanceof GithubApiError)) return apiErrorResponse(error, { code: "github_upstream_error", message: "GitHub could not be reached. Try again shortly.", status: 502 });
  if (error.status === 0) return NextResponse.json({ code: "github_upstream_error", message: "GitHub could not be reached. Check the network connection.", status: 502 });
  if (error.status === 401) {
    const response = NextResponse.json({ code: "auth_expired", message: "Your GitHub connection expired. Connect again to continue." }, { status: 401 });
    clearGithubSession(response);
    return response;
  }
  if (error.status === 403) return NextResponse.json({ code: "rate_limited", message: "GitHub rate limit reached. Try again after the limit resets.", resetAt: error.rateLimitReset }, { status: 429 });
  return NextResponse.json({ code: "github_error", message: error.message }, { status: error.status >= 400 && error.status < 500 ? error.status : 502 });
}

export function unauthenticatedResponse() {
  return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub to load this data." }, { status: 401 });
}
