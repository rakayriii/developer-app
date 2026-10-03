import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateEnvironmentInput } from "../src/lib/deployments/config.ts";
import { containerName, imageTag } from "../src/lib/deployments/docker.ts";
import { deploymentDockerTimeoutMs, DEFAULT_DEPLOYMENT_DOCKER_TIMEOUT_MS, MAX_DEPLOYMENT_DOCKER_TIMEOUT_MS, runSafeProcess } from "../src/lib/docker/client.ts";
import { discoverDockerfile } from "../src/lib/deployments/dockerfile.ts";
import { DeploymentConflictError } from "../src/lib/deployments/errors.ts";
import { hasDeploymentInProgress } from "../src/lib/deployments/state.ts";

async function repository() { return mkdtemp(path.join(os.tmpdir(), "developer-os-dockerfile-")); }

test("discovers supported Dockerfiles in deterministic priority order", async () => {
  for (const filename of ["Dockerfile", "Dockerfile.production", "Dockerfile.prod", "Dockerfile.vercel"]) {
    const root = await repository();
    await writeFile(path.join(root, filename), "FROM scratch\n");
    const result = await discoverDockerfile(root);
    assert.equal(result.name, filename);
  }

  const root = await repository();
  await writeFile(path.join(root, "Dockerfile.vercel"), "FROM scratch\n");
  await writeFile(path.join(root, "Dockerfile.prod"), "FROM scratch\n");
  await writeFile(path.join(root, "Dockerfile.production"), "FROM scratch\n");
  await writeFile(path.join(root, "Dockerfile"), "FROM scratch\n");
  assert.equal((await discoverDockerfile(root)).name, "Dockerfile");
});

test("rejects missing, traversal, outside, and symlink Dockerfiles", async () => {
  const empty = await repository();
  await assert.rejects(() => discoverDockerfile(empty), /does not contain a supported Dockerfile/);

  const nested = await repository();
  await mkdir(path.join(nested, "nested"));
  await writeFile(path.join(nested, "Dockerfile.."), "FROM scratch\n");
  await assert.rejects(() => discoverDockerfile(path.join(nested, "nested", "..")), /does not contain a supported Dockerfile/);
});

test("rejects a Dockerfile symlink that points outside the repository", async () => {
  const root = await repository();
  const outside = await repository();
  await writeFile(path.join(outside, "Dockerfile"), "FROM scratch\n");
  await symlink(path.join(outside, "Dockerfile"), path.join(root, "Dockerfile"));
  await assert.rejects(() => discoverDockerfile(root), /regular file inside the repository/);
});

test("deployment configuration accepts safe values and rejects unsafe values", () => {
  const config = validateEnvironmentInput({ name: "Production", type: "production", hostPort: 8080, containerPort: 3000, healthPath: "/health", cpuLimit: "1.5", memoryLimit: "512m" });
  assert.equal(config.slug, "production"); assert.equal(config.restartPolicy, "unless-stopped");
  assert.throws(() => validateEnvironmentInput({ hostPort: 8080, memoryLimit: "512m", healthPath: "http://evil" }), /Health path/);
  assert.throws(() => validateEnvironmentInput({ hostPort: 8080, memoryLimit: "512m", cpuLimit: "999" }), /CPU limit/);
  assert.equal(validateEnvironmentInput({ hostPort: 8080, memoryLimit: "512m", restartPolicy: "privileged" }).restartPolicy, "unless-stopped");
});

test("deployment image and container names are server-generated", () => {
  assert.equal(imageTag("demo", "deployment-id"), "developer-os/demo:deployment-deployment-id");
  assert.match(containerName("demo", "production", "deployment-id"), /^developer-os-demo-production-de/);
  assert.doesNotMatch(containerName("demo", "production", "deployment-id"), /\//);
});

test("deployment Docker timeout defaults to ten minutes and clamps configuration", () => {
  const original = process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS;
  delete process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS;
  assert.equal(deploymentDockerTimeoutMs(), DEFAULT_DEPLOYMENT_DOCKER_TIMEOUT_MS);
  process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS = "900000";
  assert.equal(deploymentDockerTimeoutMs(), MAX_DEPLOYMENT_DOCKER_TIMEOUT_MS);
  process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS = "120000";
  assert.equal(deploymentDockerTimeoutMs(), 120000);
  if (original === undefined) delete process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS;
  else process.env.DEPLOYMENT_DOCKER_TIMEOUT_MS = original;
});

test("timed-out child processes are terminated and report timeout", async () => {
  const root = await repository();
  const marker = path.join(root, "completed");
  const script = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 500); setTimeout(() => {}, 1000);`;
  await assert.rejects(() => runSafeProcess(process.execPath, ["-e", script], { timeout: 25, maxBuffer: 64 * 1024 }), (error) => error.code === "timeout");
  await new Promise((resolve) => setTimeout(resolve, 650));
  await assert.rejects(() => access(marker));
});

test("pending, building, and starting deployments reject concurrent creation", () => {
  assert.equal(hasDeploymentInProgress(["failed", "building"]), true);
  assert.equal(hasDeploymentInProgress(["failed", "stopped"]), false);
  const conflict = new DeploymentConflictError();
  assert.equal(conflict.code, "deployment_in_progress");
  assert.equal(conflict.status, 409);
});
