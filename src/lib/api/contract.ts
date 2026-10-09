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

/**
 * Why the database is unusable.
 *
 * These are genuinely different problems with different remedies, and collapsing them into one generic
 * failure is what makes an outage hard to diagnose. In particular `empty` must never be reported for a
 * failure: a UI that cannot reach the database and a UI with no projects look identical otherwise, and
 * "no projects available" is the wrong thing to say when the query never ran.
 *
 *  - unavailable        the server could not be reached at all
 *  - connection_refused the host answered but refused the connection
 *  - migrations_pending the database is reachable but the schema is behind the application
 *  - schema_incompatible the schema is present but does not match what the application expects
 *  - unauthorized        connected and authenticated, but not permitted
 *  - empty              reachable, authorised, and genuinely holding no rows
 */
export type DatabaseCondition = "unavailable" | "connection_refused" | "migrations_pending" | "schema_incompatible" | "unauthorized" | "empty" | "healthy";

const prismaCode = (error: unknown) => {
  if (typeof error !== "object" || error === null) return "";
  return "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
};
const prismaMessage = (error: unknown) => {
  if (typeof error !== "object" || error === null) return "";
  return "message" in error && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : "";
};

/** Classifies a database failure so the caller can say something true about it. */
export function classifyDatabaseError(error: unknown): Exclude<DatabaseCondition, "empty" | "healthy"> {
  const code = prismaCode(error);
  const message = prismaMessage(error);

  // Authentication and authorisation are decided by the server, so they come first: a bad password must
  // never be reported as "the database is down".
  if (code === "P1000" || /password authentication failed|no pg_hba\.conf entry|database .* does not exist/i.test(message)) return "unauthorized";

  // A refused connection is distinct from an unreachable host: something is listening and said no.
  // Checked first and case-insensitively, because the two arrive from different layers with different
  // capitalisation and "Can't reach database server" must not be read as a refusal.
  if (/ECONNREFUSED|connection refused/i.test(message)) return "connection_refused";
  if (code === "P1001" || code === "P1003" || /can't reach database server|server at .* was not found|no such host|timed out trying to connect/i.test(message)) return "unavailable";

  // A table the application expects does not exist. Which of the two schema problems it is depends on
  // whether the migration history is behind or actually inconsistent with the application.
  if (code === "P2021" || /table .* does not exist|column .* does not exist|relation .* does not exist/i.test(message)) return "schema_incompatible";
  if (code === "P3009" || /migrate deploy|migrations? (?:have not|need to) be applied|pending migration/i.test(message)) return "migrations_pending";

  if (isPrismaUnavailable(error)) return "unavailable";
  return "unavailable";
}

/** The contract response for a classified database condition. */
export function databaseConditionResponse(condition: Exclude<DatabaseCondition, "empty" | "healthy">): MappedError {
  switch (condition) {
    case "connection_refused":
      return { status: 503, body: { code: "database_connection_refused", message: "The database refused the connection. Check that PostgreSQL is accepting connections on its configured address." } };
    case "migrations_pending":
      return { status: 503, body: { code: "database_migrations_pending", message: "The database is reachable but its schema is behind this version. Apply the pending migrations." } };
    case "schema_incompatible":
      return { status: 503, body: { code: "database_schema_incompatible", message: "The database schema does not match this version of the application. Apply the pending migrations." } };
    case "unauthorized":
      // Deliberately vague: whether the role exists or the password is wrong is not something an
      // unauthenticated caller gets to learn.
      return { status: 503, body: { code: "database_unauthorized", message: "The application could not authenticate against the database. Check its database credentials." } };
    default:
      return databaseUnavailable();
  }
}

// Maps any thrown value onto the contract. Stack traces, tokens, DATABASE_URL, SSH key material,
// filesystem paths, and raw Docker payloads are never placed in the body.
export function toApiErrorBody(error: unknown, fallback: { code: string; message: string; status?: number }): MappedError {
  if (error instanceof ApiError) return { status: error.status, body: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  // A database failure is classified so the caller can tell an outage from a refused connection, a
  // pending migration, a mismatched schema, or bad credentials. Each has a different remedy.
  if (isPrismaUnavailable(error) || isDatabaseFailure(error)) return databaseConditionResponse(classifyDatabaseError(error));
  return { status: fallback.status ?? 500, body: { code: fallback.code, message: fallback.message } };
}

/**
 * True when the error came from the database layer at all, rather than from application code.
 *
 * Only errors carrying a Prisma code or a recognisable PostgreSQL message qualify. Treating an arbitrary
 * exception as a database problem would turn an application bug into a 503 about PostgreSQL.
 */
export function isDatabaseFailure(error: unknown) {
  const code = prismaCode(error);
  if (/^P\\d{4}$/.test(code)) return true;
  return /PostgreSQL|database server|prisma|pg_hba|ECONNREFUSED|table .* does not exist|column .* does not exist/i.test(prismaMessage(error));
}
