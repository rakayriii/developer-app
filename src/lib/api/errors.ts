import { NextResponse } from "next/server";
import { toApiErrorBody, type ApiErrorBody } from "./contract.ts";

export { ApiError, apiError, isApiErrorBody, isPrismaUnavailable, databaseUnavailable, type ApiErrorBody } from "./contract";

// Server-side wrapper. Every API failure in the application funnels through this so a response can
// never become an HTML document: an unhandled throw escaping a route handler makes Next serve its
// own error page, which the browser cannot parse as JSON.
export function apiErrorResponse(error: unknown, fallback: { code: string; message: string; status?: number }) {
  const mapped = toApiErrorBody(error, fallback);
  return NextResponse.json(mapped.body satisfies ApiErrorBody, { status: mapped.status });
}
