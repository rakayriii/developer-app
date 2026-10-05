import assert from "node:assert/strict";
import { test } from "node:test";
import { groupLogsByStage, normalizeLogResponse } from "../src/lib/deployments/logs.ts";

// The Phase 9 regression: the endpoint returned { entries, count } but the workspace assigned the
// raw body, leaving `logs` an object whose .length is undefined. This asserts the shape contract
// both consumers now rely on.
test("log response wrapper is read instead of being treated as a log list", () => {
  const rows = [{ id: "l1", timestamp: "2026-10-04T00:00:00.000Z", stream: "build", message: "Docker image build completed." }];
  const wrapped = normalizeLogResponse({ deploymentId: "d1", entries: rows, count: 1 });
  assert.equal(wrapped.length, 1, "a { entries } body must not collapse to an empty list");
  assert.equal(wrapped[0].message, "Docker image build completed.");
  assert.equal(wrapped[0].stage, "build");
  assert.equal(wrapped[0].severity, "info");
});

test("legacy bare-array log responses are still accepted", () => {
  const entries = normalizeLogResponse([{ id: "l1", timestamp: "t", stream: "health", message: "HTTP 200" }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, "health");
});

test("a real GameVault deploy produces the expected persisted stages", () => {
  const rows = [
    { id: "1", timestamp: "t1", stream: "validation", message: "Build started for 31eb879ed992." },
    { id: "2", timestamp: "t2", stream: "validation", message: "Dockerfile: Dockerfile.vercel" },
    { id: "3", timestamp: "t3", stream: "validation", message: "Runtime variables configured: APP_DEBUG, APP_ENV, APP_KEY (values are never logged)." },
    { id: "4", timestamp: "t4", stream: "build", message: "Docker image build completed." },
    { id: "5", timestamp: "t5", stream: "container", message: "Container developer-os-gamevault-development-x started." },
    { id: "6", timestamp: "t6", stream: "release", message: "Running database migrations." },
    { id: "7", timestamp: "t7", stream: "release", message: "Database migrations completed." },
    { id: "8", timestamp: "t8", stream: "health", message: "HTTP 200" },
  ];
  const entries = normalizeLogResponse({ entries: rows, count: rows.length });
  const { ordered } = groupLogsByStage(entries);
  const stages = ordered.map((group) => group.stage);
  for (const expected of ["validation", "build", "container", "release", "health"]) assert.ok(stages.includes(expected), `${expected} stage must be grouped`);
  assert.equal(ordered.find((group) => group.stage === "validation").entries.length, 3);
  assert.equal(ordered.find((group) => group.stage === "health").entries[0].message, "HTTP 200");
  assert.ok(ordered.find((group) => group.stage === "validation").entries[2].message.includes("APP_KEY"));
  assert.ok(!ordered.find((group) => group.stage === "validation").entries[2].message.includes("base64:"));
});

test("a stream name absent from the known set is normalized to the runtime stage", () => {
  const entries = normalizeLogResponse({ entries: [{ id: "z", timestamp: "t", stream: "brand_new_stage", message: "m" }] });
  assert.equal(entries[0].stage, "runtime");
  assert.equal(entries[0].stream, "brand_new_stage", "the raw stream is preserved for traceability");
  assert.equal(groupLogsByStage(entries).ordered[0].stage, "runtime");
});

test("logs are grouped in lifecycle order and unknown stages are collected separately", () => {
  const entries = normalizeLogResponse({ entries: [
    { id: "a", timestamp: "t", stream: "health", message: "HTTP 200" },
    { id: "b", timestamp: "t", stream: "build", message: "build" },
    { id: "c", timestamp: "t", stream: "legacy_stream", message: "unknown" },
    { id: "d", timestamp: "t", stream: "restart", message: "restarted" },
  ] });
  const { ordered, other } = groupLogsByStage(entries);
  // lifecycle order is build -> health -> runtime -> restart; the unknown stream degrades into runtime.
  assert.deepEqual(ordered.map((group) => group.stage), ["build", "health", "runtime", "restart"]);
  assert.equal(other.length, 0);
});

test("empty state only appears when there are genuinely zero persisted logs", () => {
  // The exact shapes a real endpoint can return when the database has no rows for a deployment.
  for (const body of [{ deploymentId: "d1", entries: [], count: 0 }, [], { entries: [] }, {}, null, undefined]) {
    assert.deepEqual(normalizeLogResponse(body), [], `${JSON.stringify(body)} must yield no entries`);
    assert.equal(groupLogsByStage(normalizeLogResponse(body)).ordered.length, 0);
  }
  // And a non-empty payload must never collapse to empty.
  assert.notEqual(normalizeLogResponse({ entries: [{ id: "x", timestamp: "t", stream: "build", message: "m" }] }).length, 0);
});

test("a non-array entries field is rejected rather than crashing the renderer", () => {
  assert.deepEqual(normalizeLogResponse({ entries: "oops" }), []);
  assert.deepEqual(normalizeLogResponse({ entries: [null, 5, "x"] }), []);
  assert.equal(normalizeLogResponse({ entries: [{ id: "k", timestamp: "t", stream: "error", message: "[health_check] boom" }] })[0].severity, "error");
});

test("rows missing fields degrade safely instead of producing undefined output", () => {
  const entries = normalizeLogResponse({ entries: [{ id: "k" }, { message: "only message" }] });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].stream, "runtime");
  assert.equal(entries[0].stage, "runtime");
  assert.equal(entries[0].message, "");
  assert.equal(entries[1].message, "only message");
});

test("operation logs stay associated with the deployment that produced them", () => {
  // Stop/restart write to the affected deployment id; rollback/redeploy create a new id and write there.
  const original = normalizeLogResponse({ entries: [
    { id: "o1", timestamp: "t", stream: "validation", message: "Build started for 31eb879ed992." },
    { id: "o2", timestamp: "t", stream: "stop", message: "Stopping owned container developer-os-gamevault-development-a." },
  ] });
  const rollback = normalizeLogResponse({ entries: [
    { id: "r1", timestamp: "t", stream: "rollback", message: "Rolling back to known-good deployment abc." },
    { id: "r2", timestamp: "t", stream: "health", message: "HTTP 200" },
  ] });
  assert.equal(original.filter((entry) => entry.stream === "stop").length, 1, "stop log stays on the original deployment");
  assert.equal(original.some((entry) => entry.stage === "rollback"), false, "rollback logs must not leak into the original deployment");
  assert.equal(rollback.filter((entry) => entry.stage === "rollback").length, 1, "rollback writes to its own deployment");
});
