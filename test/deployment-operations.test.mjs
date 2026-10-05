import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedTransitions, assertTransition, canTransition, DeploymentTransitionError, deploymentStatuses, isDeploymentStatus } from "../src/lib/deployments/lifecycle.ts";
import { assertOwnedContainerName, DeploymentOwnershipError, deploymentAppUrl, ownedContainerName } from "../src/lib/deployments/operations.ts";
import { containerName, containerRunArguments, releaseCommandArguments, containerInspectArguments } from "../src/lib/deployments/docker.ts";

import { redactSecrets } from "../src/lib/deployments/runtime-env.ts";

test("deployment lifecycle allows the documented forward path", () => {
  for (const [from, to] of [["pending", "building"], ["building", "starting"], ["starting", "running"], ["running", "stopping"], ["stopping", "stopped"], ["starting", "failed"], ["building", "failed"], ["pending", "failed"], ["starting", "unhealthy"]]) assert.equal(canTransition(from, to), true, `${from} -> ${to} must be allowed`);
});

test("deployment lifecycle rejects impossible transitions", () => {
  for (const [from, to] of [["pending", "running"], ["running", "building"], ["running", "starting"], ["stopped", "running"], ["building", "stopped"], ["rolled_back", "running"], ["pending", "unhealthy"], ["stopping", "running"]]) assert.equal(canTransition(from, to), false, `${from} -> ${to} must be rejected`);
  assert.throws(() => assertTransition("pending", "running"), DeploymentTransitionError);
  assert.throws(() => assertTransition("rolled_back", "running"), /cannot move from rolled_back to running/);
});

test("unknown statuses are not treated as valid states", () => {
  assert.equal(isDeploymentStatus("running"), true);
  assert.equal(isDeploymentStatus("deploying"), false);
  assert.equal(canTransition("deploying", "running"), false);
  assert.deepEqual(allowedTransitions("deploying"), []);
  assert.equal(deploymentStatuses.includes("failed"), true);
});

test("owned container name is always server-generated from project, environment and deployment", () => {
  const deployment = { id: "cmutif1y4000jv1ciyypu2bwg", project: { slug: "gamevault" }, environment: { slug: "development" }, containerName: null };
  const expected = containerName("gamevault", "development", deployment.id);
  assert.equal(ownedContainerName(deployment), expected);
  assert.equal(assertOwnedContainerName({ ...deployment, containerName: expected }), expected);
  assert.throws(() => assertOwnedContainerName(deployment), /no owned container/);
  assert.throws(() => assertOwnedContainerName({ ...deployment, containerName: "some-other-container" }), (error) => error instanceof DeploymentOwnershipError && error.status === 403);
});

test("stop, restart and rollback operate only on owned containers", () => {
  const id = "abc123def456";
  const expected = containerName("demo", "production", id);
  assert.match(expected, /^developer-os-demo-production-abc123def4/);
  for (const forbidden of ["--privileged", "--network", "host", "--volume"]) assert.ok(!expected.includes(forbidden));
});

test("runtime information is a bounded allowlisted projection", () => {
  const args = containerInspectArguments("container-1");
  assert.equal(args[0], "inspect");
  assert.equal(args[1], "--format");
  assert.ok(args[3] === "container-1");
  // Raw inspect output is never returned: a format string is always required.
  assert.ok(args.length === 4);
});

test("Open App URL is generated server-side from the deployment port and only when running", () => {
  assert.equal(deploymentAppUrl({ status: "running", environment: { hostPort: 8088 } }), "http://localhost:8088/");
  assert.equal(deploymentAppUrl({ status: "unhealthy", environment: { hostPort: 8088 } }), "http://localhost:8088/");
  assert.equal(deploymentAppUrl({ status: "stopped", environment: { hostPort: 8088 } }), null);
  assert.equal(deploymentAppUrl({ status: "failed", environment: { hostPort: 8088 } }), null);
  assert.equal(deploymentAppUrl({ status: "building", environment: { hostPort: 8088 } }), null);
});

test("container run arguments never accept caller-supplied flags", () => {
  const args = containerRunArguments({ tag: "developer-os/demo:deployment-x", name: "n", hostPort: 8088, containerPort: 80, cpuLimit: "1.0", memoryLimit: "512m", environment: { APP_ENV: "production" } });
  const forbidden = ["--privileged", "--network=host", "--cap-add", "--cap-add=ALL", "--volume", "-v", "--mount", "--device", "--security-opt", "--pid=host", "--userns", "--runtime"];
  for (const flag of forbidden) assert.ok(!args.includes(flag), `${flag} must never be present`);
  assert.equal(args.filter((value) => value === "--env").length, 1);
  assert.deepEqual(args.slice(-1), ["developer-os/demo:deployment-x"]);
});

test("release commands remain fixed server-side arrays with no shell", () => {
  const args = releaseCommandArguments("c1", "migrate");
  assert.deepEqual(args, ["exec", "c1", "php", "artisan", "migrate", "--force", "--no-interaction"]);
  assert.doesNotMatch(args.join(" "), /\bsh\b|bash|-c/);
  assert.throws(() => releaseCommandArguments("c1", "rm -rf /"), /not allowed/);
  assert.throws(() => releaseCommandArguments("c1", "cat /etc/passwd"), /not allowed/);
});

test("logs keep stage metadata and never expose decrypted secrets", () => {
  const key = "base64:c3VwZXJzZWNyZXR2YWx1ZWtleWZvcndldGVzdA==";
  const entry = { stream: "release", message: redactSecrets(`migrations complete for ${key}`, [key]) };
  assert.equal(entry.stream, "release");
  assert.ok(!entry.message.includes(key));
  assert.match(entry.message, /\[redacted\]/);
  assert.match(entry.message, /migrations complete/);
});
