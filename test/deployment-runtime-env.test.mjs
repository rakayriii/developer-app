import assert from "node:assert/strict";
import { test } from "node:test";
import { containerRunArguments, releaseCommandArguments, healthCheck } from "../src/lib/deployments/docker.ts";
import { decryptSecret, encryptSecret } from "../src/lib/deployments/crypto.ts";
import { isSecretRuntimeVariable, missingRuntimeVariables, parseRuntimeVariableList, redactSecrets, RuntimeVariableError, runtimeVariableNames, serverControlledVariableNames, validateRuntimeVariable } from "../src/lib/deployments/runtime-env.ts";

process.env.SESSION_SECRET ||= "test-session-secret-for-runtime-environment-suite";

test("runtime allowlist covers the documented Laravel surface and reserves PORT", () => {
  for (const name of ["APP_KEY", "APP_ENV", "APP_DEBUG", "APP_URL", "DB_CONNECTION", "DB_HOST", "DB_PORT", "DB_DATABASE", "DB_USERNAME", "DB_PASSWORD", "SESSION_DRIVER", "CACHE_STORE", "QUEUE_CONNECTION"]) assert.ok(runtimeVariableNames.includes(name), `${name} must be allowed`);
  assert.ok(serverControlledVariableNames.includes("PORT"));
  assert.ok(!runtimeVariableNames.includes("PORT"));
  assert.ok(!runtimeVariableNames.includes("DOCKER_HOST"));
  assert.equal(isSecretRuntimeVariable("APP_KEY"), true);
  assert.equal(isSecretRuntimeVariable("DB_PASSWORD"), true);
  assert.equal(isSecretRuntimeVariable("APP_URL"), false);
});

test("GameVault-style Laravel runtime configuration validates", () => {
  const variables = parseRuntimeVariableList({ variables: [
    { name: "APP_KEY", value: "base64:VEhJU0lTQU5PVEFGTEVHSUNLRVktUk9PTT9DSEFOR0VG" },
    { name: "APP_ENV", value: "production" },
    { name: "APP_DEBUG", value: "false" },
    { name: "APP_URL", value: "http://localhost:8088" },
    { name: "DB_CONNECTION", value: "sqlite" },
    { name: "DB_DATABASE", value: "/app/database/database.sqlite" },
    { name: "SESSION_DRIVER", value: "file" },
    { name: "CACHE_STORE", value: "file" },
    { name: "QUEUE_CONNECTION", value: "sync" },
  ] });
  assert.equal(variables.length, 9);
  assert.equal(variables.find((item) => item.name === "APP_KEY").secret, true);
  assert.equal(variables.find((item) => item.name === "APP_URL").secret, false);
});

test("runtime variable names outside the allowlist and PORT are rejected", () => {
  assert.throws(() => validateRuntimeVariable("PORT", "80"), /controlled by the deployment engine/);
  assert.throws(() => validateRuntimeVariable("LD_PRELOAD", "/tmp/x.so"), /not an allowed runtime variable/);
  assert.throws(() => validateRuntimeVariable("DOCKER_SOCKET", "/var/run/docker.sock"), /not an allowed runtime variable/);
  assert.throws(() => validateRuntimeVariable("APP_KEY", 42), /must be a string/);
  assert.throws(() => parseRuntimeVariableList({ variables: "APP_KEY=x" }), /must be provided as a list/);
});

test("runtime variable values reject shell, newline, and null injection", () => {
  assert.throws(() => validateRuntimeVariable("APP_URL", "http://x/$(id)"), /unsupported character/);
  assert.throws(() => validateRuntimeVariable("APP_URL", "http://x/\nInjected: 1"), /unsupported character/);
  assert.throws(() => validateRuntimeVariable("APP_KEY", "bad\0value"), /invalid character/);
  assert.throws(() => validateRuntimeVariable("APP_KEY", "x".repeat(2000)), /maximum secret length/);
  assert.throws(() => validateRuntimeVariable("APP_URL", "x".repeat(600)), /maximum length/);
  assert.equal(new RuntimeVariableError("x").status, 400);
});

test("secrets round-trip through authenticated encryption and never appear in plaintext storage", () => {
  const secret = "base64:c3VwZXJzZWNyZXR2YWx1ZWtleWZvcmRldGVzdA==";
  const ciphertext = encryptSecret(secret);
  assert.notEqual(ciphertext, secret);
  assert.ok(!ciphertext.includes(secret));
  assert.equal(decryptSecret(ciphertext), secret);
  assert.equal(decryptSecret("garbage"), null);
  assert.notEqual(encryptSecret(secret), ciphertext);
});

test("redactSecrets removes secret values from deploy output", () => {
  const key = "base64:VEhJU0lTQUNSRVRLRVlXT1JUQUxURVNULUZPUi1URVNUUw==";
  const password = "sup3r-s3cret-passphrase";
  const redacted = redactSecrets(`APP_KEY=${key} DB_PASSWORD=${password} build done`, [key, password]);
  assert.ok(!redacted.includes(key));
  assert.ok(!redacted.includes(password));
  assert.match(redacted, /build done/);
  assert.match(redacted, /\[redacted\]/);
});

test("missing runtime variables can be reported by name only", () => {
  const missing = missingRuntimeVariables(["APP_KEY", "DB_CONNECTION"]);
  assert.ok(missing.includes("APP_URL"));
  assert.ok(!missing.includes("APP_KEY"));
});

test("container run arguments inject allowlisted variables and keep PORT server-controlled", () => {
  const args = containerRunArguments({ tag: "developer-os/gamevault:deployment-abc", name: "developer-os-gamevault-development-abc", hostPort: 8088, containerPort: 80, cpuLimit: "1.0", memoryLimit: "512m", environment: { PORT: "80", APP_KEY: "base64:abc", APP_ENV: "production" } });
  assert.deepEqual(args.slice(-1), ["developer-os/gamevault:deployment-abc"]);
  assert.ok(args.includes("--publish"));
  assert.ok(args.includes("8088:80"));
  assert.ok(args.includes("APP_KEY=base64:abc"));
  assert.ok(args.includes("APP_ENV=production"));
  for (const forbidden of ["--privileged", "--network=host", "--cap-add", "--volume", "-v", "--mount", "--pid=host"]) assert.ok(!args.includes(forbidden), `${forbidden} must never be passed`);
  assert.equal(args.filter((value) => value === "--env").length, 3);
});

test("release commands are fixed server-side argument arrays and cannot be parameterized", () => {
  const args = releaseCommandArguments("container-123", "migrate");
  assert.deepEqual(args, ["exec", "container-123", "php", "artisan", "migrate", "--force", "--no-interaction"]);
  assert.throws(() => releaseCommandArguments("container-123", "rm -rf /"), /not allowed/);
  assert.throws(() => releaseCommandArguments("container-123", "shell"), /not allowed/);
  assert.doesNotMatch(args.join(" "), /sh\b|-c/);
});

test("health check reports a useful failure reason instead of a generic message", async () => {
  const result = await healthCheck(65530, "/", 300, 1);
  assert.equal(result.healthy, false);
  assert.equal(result.url, "http://127.0.0.1:65530/");
  assert.equal(result.status, null);
  assert.ok(result.transportError, "a transport error must be reported");
  assert.match(result.message, /65530/);
});
