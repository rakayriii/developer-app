import { NextResponse } from "next/server";

// A catch-all for API paths that no route claims.
//
// The application's own 404 handling redirects an unknown *page* to the workspace home, which is right for
// a person following a stale link and wrong for a program expecting JSON. Without this route an unmatched
// `/api/...` request would be redirected to an HTML page, so an API client would receive HTML where the
// error contract promises `{ code, message }`.
//
// Specific API routes still win: Next.js matches a concrete segment before a catch-all, so this only
// handles paths that genuinely have no handler.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound() {
  // The path is deliberately not echoed back. It is caller-supplied and has no value in the response.
  return NextResponse.json({ code: "not_found", message: "No such API route." }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;