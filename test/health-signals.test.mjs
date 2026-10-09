import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { describeHealthSignals, healthSignalsDisagree, healthStatusFor, normalizeDockerHealth } from "../src/lib/reliability/health-signals.ts";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

describe("Docker's HEALTHCHECK is advisory and never decides the deployment's health", () => {
  it("treats an image that declares no healthcheck as not declaring one, not as failing", () => {
    // Docker reports "none" for a container whose image declares no HEALTHCHECK. That is an absence,
    // not a failure.
    assert.equal(normalizeDockerHealth("none"), "none");
    assert.equal(normalizeDockerHealth("NONE"), "none");
    // An empty or unreadable value is genuinely unknown, and is not silently read as "none".
    assert.equal(normalizeDockerHealth(""), "unknown");
    assert.equal(normalizeDockerHealth(null), "unknown");
    assert.equal(normalizeDockerHealth(undefined), "unknown");
  });

  it("records healthy when the application answers, whatever the image's healthcheck says", () => {
    // This is the GameVault case: the image probes a port the app does not serve, and the app is fine.
    assert.equal(healthStatusFor({ applicationHttp: "healthy", containerRunning: true }), "healthy");
    assert.equal(healthSignalsDisagree({ dockerHealthcheck: "unhealthy", applicationHttp: "healthy" }), true);
  });

  it("records unhealthy when the application does not answer", () => {
    assert.equal(healthStatusFor({ applicationHttp: "unhealthy", containerRunning: true }), "unhealthy");
    assert.equal(healthStatusFor({ applicationHttp: "unknown", containerRunning: true }), "unhealthy");
    assert.equal(healthSignalsDisagree({ dockerHealthcheck: "unhealthy", applicationHttp: "unhealthy" }), false);
  });

  it("records unhealthy when the application answers but the container is not running", () => {
    assert.equal(healthStatusFor({ applicationHttp: "healthy", containerRunning: false }), "unhealthy");
  });

  it("surfaces a disagreement as a finding rather than hiding it", () => {
    const lines = describeHealthSignals({
      dockerHealthcheck: "unhealthy", applicationHttp: "healthy", containerRunning: true,
      reverseProxy: "healthy", tlsCertificate: "healthy",
    });
    assert.ok(lines.some((line) => line.includes("image's HEALTHCHECK disagrees")));
    assert.ok(lines.some((line) => line.includes("application HTTP: healthy")));
  });

  it("reports each signal separately, and says 'not declared' rather than failing", () => {
    const lines = describeHealthSignals({
      dockerHealthcheck: "none", applicationHttp: "healthy", containerRunning: true,
      reverseProxy: null, tlsCertificate: null,
    });
    assert.ok(lines.some((line) => line.includes("image healthcheck: not declared")));
    // A deployment with no domain has no proxy or certificate signal; they are omitted, not invented.
    assert.ok(!lines.some((line) => line.startsWith("reverse proxy")));
    assert.ok(!lines.some((line) => line.startsWith("TLS certificate")));
  });

  it("includes proxy and certificate signals when they apply", () => {
    const lines = describeHealthSignals({
      dockerHealthcheck: "healthy", applicationHttp: "healthy", containerRunning: true,
      reverseProxy: "unhealthy", tlsCertificate: "healthy",
    });
    assert.ok(lines.some((line) => line === "reverse proxy: unhealthy"));
    assert.ok(lines.some((line) => line === "TLS certificate: healthy"));
  });
});

describe("the deployment record's health is written only from the application's own answer", () => {
  const service = read("src/lib/deployments/service.ts");

  it("never derives the persisted health from the container's Docker health field", () => {
    // Every healthStatus write must sit next to a check that made an HTTP request, never beside a read of
    // the image's HEALTHCHECK.
    const writes = [...service.matchAll(/healthStatus:\s*"(\w+)"/g)].map((match) => match[1]);
    assert.ok(writes.length > 0, "there must be health writes to check");
    for (const value of writes) {
      assert.ok(["healthy", "unhealthy", "stopped", "rolled_back"].includes(value), `unexpected health value ${value}`);
    }
    assert.doesNotMatch(service, /healthStatus:\s*[^,]*\.health\b/, "healthStatus must not be assigned from the Docker health field");
    assert.doesNotMatch(service, /healthStatus:\s*runtime\./, "healthStatus must not be assigned from a container runtime read");
  });

  it("keeps the Docker healthcheck available as its own separate reading", () => {
    // The runtime projection is where the image's own opinion is surfaced.
    const projection = read("src/lib/deployments/docker.ts");
    assert.match(projection, /health:\s*string/);
    assert.match(projection, /\.State\.Health\.Status/);
  });

  it("never edits GameVault or its Dockerfile to make a signal agree", () => {
    // The image's healthcheck is the image's business. The application ships no override.
    const gitignore = read(".gitignore");
    assert.ok(gitignore.length > 0);
    const appSources = read("src/lib/reliability/health-signals.ts");
    assert.match(appSources, /GameVault image is exactly that case/);
    assert.doesNotMatch(appSources, /GameVault.*Dockerfile.*(write|patch|modify)/);
  });
});