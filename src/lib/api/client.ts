import { isApiErrorBody, type ApiErrorBody } from "./contract.ts";

export type ApiResult<T> = { ok: true; data: T; status: number } | { ok: false; status: number; error: ApiErrorBody };

// Reads an API response without ever throwing. A route that does not resolve, a proxy that answers
// with HTML, or a gateway error page must not surface as a raw "Unexpected token '<'" SyntaxError:
// those are normalized into the same { code, message } contract the UI already understands.
export async function readApiJson<T = unknown>(response: Response): Promise<ApiResult<T>> {
  const contentType = response.headers.get("content-type") || "";
  const status = response.status;

  let text: string;
  try { text = await response.text(); } catch { return { ok: false, status, error: { code: "response_unreadable", message: "The server response could not be read." } }; }

  if (!contentType.includes("json")) {
    return {
      ok: false,
      status,
      error: {
        code: status === 404 ? "not_found" : "invalid_response",
        message: status === 404
          ? "The requested resource does not exist."
          : `The server returned a non-JSON response (${status}${contentType ? `, ${contentType.split(";")[0]}` : ""}).`,
      },
    };
  }

  if (!text.trim()) return { ok: false, status, error: { code: "invalid_response", message: "The server returned an empty response." } };

  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { return { ok: false, status, error: { code: "invalid_response", message: "The server returned a malformed JSON response." } }; }

  if (!response.ok) {
    return { ok: false, status, error: isApiErrorBody(parsed) ? parsed : { code: "request_failed", message: `Request failed with status ${status}.` } };
  }
  return { ok: true, data: parsed as T, status };
}

// Convenience for the common "raise the normalized error" flow.
export async function readApiJsonOrThrow<T = unknown>(response: Response): Promise<T> {
  const result = await readApiJson<T>(response);
  if (!result.ok) throw Object.assign(new Error(result.error.message), result.error);
  return result.data;
}

export type { ApiErrorBody };
