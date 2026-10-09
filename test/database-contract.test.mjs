import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDatabaseError, databaseConditionResponse, isDatabaseFailure, isPrismaUnavailable } from "../src/lib/api/contract.ts";

/** A failure shaped the way Prisma surfaces it. */
const prisma = (code, message) => Object.assign(new Error(message), { code });

describe("database failures are distinguished, not collapsed", () => {
  it("reports an unreachable server as unavailable", () => {
    assert.equal(classifyDatabaseError(prisma("P1001", "Can't reach database server at postgres:5432")), "unavailable");
    assert.equal(classifyDatabaseError(new Error("Can't reach database server at host:5433")), "unavailable");
    assert.equal(classifyDatabaseError(prisma("P1001", "Server was not found or unreachable at host:5433")), "unavailable");
  });

  it("reports a refused connection separately from an unreachable host", () => {
    // Something is listening and said no. That is a different problem with a different fix.
    assert.equal(classifyDatabaseError(new Error("connect ECONNREFUSED 127.0.0.1:5433")), "connection_refused");
    const response = databaseConditionResponse("connection_refused");
    assert.equal(response.status, 503);
    assert.equal(response.body.code, "database_connection_refused");
  });

  it("reports a pending migration separately again", () => {
    assert.equal(classifyDatabaseError(prisma("P3009", "migrate deploy found pending migrations")), "migrations_pending");
    assert.equal(databaseConditionResponse("migrations_pending").body.code, "database_migrations_pending");
  });

  it("reports an incompatible schema separately from a pending migration", () => {
    assert.equal(classifyDatabaseError(prisma("P2021", 'Table public."Project" does not exist')), "schema_incompatible");
    assert.equal(classifyDatabaseError(new Error('relation "Deployment" does not exist')), "schema_incompatible");
    assert.equal(databaseConditionResponse("schema_incompatible").body.code, "database_schema_incompatible");
  });

  it("reports bad credentials without revealing which part was wrong", () => {
    assert.equal(classifyDatabaseError(prisma("P1000", "password authentication failed for user developer_os")), "unauthorized");
    assert.equal(classifyDatabaseError(new Error('no pg_hba.conf entry for host "10.0.0.1"')), "unauthorized");
    const body = databaseConditionResponse("unauthorized").body;
    assert.equal(body.code, "database_unauthorized");
    // Nothing about the role or the password may be echoed back.
    assert.doesNotMatch(JSON.stringify(body), /developer_os|password|pg_hba/i);
  });

  it("checks authentication before availability, so bad credentials are not called an outage", () => {
    // Both signals present; the more specific and more actionable one wins.
    const error = prisma("P1000", "password authentication failed: can't reach database server at postgres:5432");
    assert.equal(classifyDatabaseError(error), "unauthorized");
  });

  it("falls back to unavailable for an unrecognised database-shaped error", () => {
    assert.equal(classifyDatabaseError(prisma("P9999", "something unexpected from the driver")), "unavailable");
  });

  it("does not treat an ordinary application error as a database problem", () => {
    assert.equal(isDatabaseFailure(new Error("Cannot read properties of undefined")), false);
    assert.equal(isDatabaseFailure(new TypeError("x is not a function")), false);
  });

  it("still recognises the original unavailability detector", () => {
    assert.equal(isPrismaUnavailable(prisma("P1001", "Can't reach database server")), true);
    assert.equal(isPrismaUnavailable(new Error("plain failure")), false);
  });

  it("never puts a connection string or credential in any response", () => {
    for (const condition of ["unavailable", "connection_refused", "migrations_pending", "schema_incompatible", "unauthorized"]) {
      const serialized = JSON.stringify(databaseConditionResponse(condition));
      assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//, `${condition} leaks a connection string`);
      assert.doesNotMatch(serialized, /hunter2|DATABASE_URL/, `${condition} leaks a credential`);
      assert.ok(!("stack" in databaseConditionResponse(condition).body));
    }
  });

  it("uses 503 for every dependency failure, since none of them is the caller's fault", () => {
    for (const condition of ["unavailable", "connection_refused", "migrations_pending", "schema_incompatible", "unauthorized"]) {
      assert.equal(databaseConditionResponse(condition).status, 503);
    }
  });

  it("never returns 200 with an empty body for a failure", () => {
    // A UI that cannot reach the database must be told so, not handed an empty list to render as
    // "no projects available".
    const response = databaseConditionResponse("unavailable");
    assert.equal(response.body.code, "database_unavailable");
    assert.ok(response.body.message.length > 0);
  });
});