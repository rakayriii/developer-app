// Pure error contract. Deliberately free of any Next.js import so it can be shared by route
// handlers, client components, and unit tests without pulling server code into the browser bundle.

export type ApiErrorBody = { code: string; message: string; details?: unknown };
export type MappedError = { status: number; body: ApiErrorBody };

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(code: string, message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const apiError = (code: string, message: string, status = 500, details?: unknown) => new ApiError(code, message, status, details);

// A database outage must never be reported as "no data" or as an opaque 500. Prisma surfaces an
// unreachable server either as a known code or, during query initialisation, as a plain message
// carrying no code at all, so both shapes are recognised.
export function isPrismaUnavailable(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (code === "P1001" || code === "P2021" || code === "P1003") return true;
  const message = "message" in error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
  return /can't reach database server|database server at|no pg_hba|ECONNREFUSED.*5432/i.test(message);
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string" && typeof (value as { message?: unknown }).message === "string";
}

export const databaseUnavailable = (): MappedError => ({ status: 503, body: { code: "database_unavailable", message: "The application database is unavailable. Start PostgreSQL and try again." } });

// Maps any thrown value onto the contract. Stack traces, tokens, DATABASE_URL, SSH key material,
// filesystem paths, and raw Docker payloads are never placed in the body.
export function toApiErrorBody(error: unknown, fallback: { code: string; message: string; status?: number }): MappedError {
  if (error instanceof ApiError) return { status: error.status, body: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  if (isPrismaUnavailable(error)) return databaseUnavailable();
  return { status: fallback.status ?? 500, body: { code: fallback.code, message: fallback.message } };
}
