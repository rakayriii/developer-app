import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, apiError, databaseUnavailable, isApiErrorBody, isPrismaUnavailable, toApiErrorBody } from "../src/lib/api/contract.ts";
import { readApiJson, readApiJsonOrThrow } from "../src/lib/api/client.ts";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// ---------- the reported bug: HTML arriving where JSON was expected ----------

describe("readApiJson never throws on a non-JSON response", () => {
  it("normalizes the HTML 404 an unresolved API path returns", async () => {
    const result = await readApiJson(html('<!DOCTYPE html><html lang="en"></html>', 404));
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.error.code, "not_found");
    assert.equal(result.error.message, "The requested resource does not exist.");
    assert.ok(!result.error.message.includes("<"), "no HTML leaks into the message");
  });

  it("normalizes an HTML gateway error page with a 5xx status", async () => {
    const result = await readApiJson(html("<!DOCTYPE html><html><body>502 Bad Gateway</body></html>", 502));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /non-JSON response \(502, text\/html\)/);
  });

  it("reports malformed JSON instead of a SyntaxError", async () => {
    const result = await readApiJson(new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /malformed JSON/);
  });

  it("reports an empty body instead of a SyntaxError", async () => {
    const result = await readApiJson(new Response("", { status: 200, headers: { "content-type": "application/json" } }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_response");
    assert.match(result.error.message, /empty response/);
  });

  it("never surfaces a raw parser message to the UI", async () => {
    const result = await readApiJson(html("<!DOCTYPE html>", 500));
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, "string");
    assert.equal(typeof result.error.message, "string");
    assert.doesNotMatch(result.error.message, /Unexpected token|JSON\.parse|is not valid JSON/);
  });

  it("readApiJsonOrThrow raises the normalized error, not a parser SyntaxError", async () => {
    await assert.rejects(() => readApiJsonOrThrow(html("<!DOCTYPE html>", 404)), (error) => error.code === "not_found" && !(error instanceof SyntaxError));
  });
});

describe("readApiJson preserves the API error contract", () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    it(`passes a ${status} JSON error through unchanged`, async () => {
      const body = { code: `code_${status}`, message: `message ${status}` };
      const result = await readApiJson(json(body, status));
      assert.equal(result.ok, false);
      assert.equal(result.status, status);
      assert.deepEqual(result.error, body);
    });
  }

  it("falls back to a synthetic contract when an error body is not shaped like one", async () => {
    const result = await readApiJson(json({ oops: true }, 500));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "request_failed");
    assert.match(result.error.message, /status 500/);
  });

  it("returns data on success and tolerates a charset suffix", async () => {
    const response = new Response(JSON.stringify({ items: [1, 2] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    const result = await readApiJson(response);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.data.items, [1, 2]);
  });
});

// ---------- database outage classification ----------

describe("database outage detection", () => {
  for (const code of ["P1001", "P2021", "P1003"]) it(`recognizes Prisma ${code}`, () => assert.equal(isPrismaUnavailable({ code }), true));

  it("recognizes an unreachable server reported only by message", () => {
    assert.equal(isPrismaUnavailable(new Error("Invalid `prisma.deployment.findMany()` invocation:\nCan't reach database server at `localhost:5433`")), true);
  });

  it("does not classify unrelated failures as a database outage", () => {
    assert.equal(isPrismaUnavailable(new Error("boom")), false);
    assert.equal(isPrismaUnavailable({ code: "P2002" }), false);
    assert.equal(isPrismaUnavailable(null), false);
    assert.equal(isPrismaUnavailable(undefined), false);
    assert.equal(isPrismaUnavailable("ECONNREFUSED somewhere else"), false);
  });

  it("maps a database outage to a structured 503, not an opaque 500", () => {
    const mapped = toApiErrorBody(new Error("Can't reach database server at `localhost:5433`"), { code: "deployment_error", message: "fallback" });
    assert.equal(mapped.status, 503);
    assert.deepEqual(mapped.body, { code: "database_unavailable", message: "The application database is unavailable. Start PostgreSQL and try again." });
    assert.deepEqual(databaseUnavailable().body.code, "database_unavailable");
  });

  it("keeps unrelated failures on the fallback contract", () => {
    const mapped = toApiErrorBody(new Error("boom"), { code: "deployment_error", message: "fallback" });
    assert.equal(mapped.status, 500);
    assert.deepEqual(mapped.body, { code: "deployment_error", message: "fallback" });
  });
});

// ---------- error body shape ----------

describe("api error contract", () => {
  it("is always { code, message } with optional details", () => {
    const mapped = toApiErrorBody(apiError("validation_error", "bad input", 400, { field: "name" }), { code: "x", message: "y" });
    assert.equal(mapped.status, 400);
    assert.deepEqual(mapped.body, { code: "validation_error", message: "bad input", details: { field: "name" } });
    assert.ok(new ApiError("x", "y") instanceof Error);
  });

  it("omits details when none are supplied", () => {
    const mapped = toApiErrorBody(new ApiError("forbidden", "nope", 403), { code: "x", message: "y" });
    assert.deepEqual(Object.keys(mapped.body).sort(), ["code", "message"]);
  });

  it("validates error bodies", () => {
    assert.equal(isApiErrorBody({ code: "a", message: "b" }), true);
    assert.equal(isApiErrorBody({ code: "a" }), false);
    assert.equal(isApiErrorBody({ message: "b" }), false);
    assert.equal(isApiErrorBody("nope"), false);
    assert.equal(isApiErrorBody(null), false);
  });

  it("never carries a stack trace or connection string in the body", () => {
    const mapped = toApiErrorBody(new Error("connect postgresql://developer_os:hunter2@localhost:5433 failed"), { code: "server_error", message: "The server operation failed." });
    const serialized = JSON.stringify(mapped.body);
    assert.ok(!serialized.includes("hunter2"), "credentials must not reach the response");
    assert.ok(!serialized.includes("postgresql://"), "connection string must not reach the response");
    assert.ok(!("stack" in mapped.body));
  });
});
