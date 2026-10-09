import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArchitectureMismatchError,
  architectureFailureReason,
  assertCompatibleArchitecture,
  canonicalArchitecture,
  compareArchitectures,
  describeArchitecture,
} from "../src/lib/deployments/architecture.ts";

// -------------------------------------------------------------------------------------------
// Normalization
// -------------------------------------------------------------------------------------------
describe("architecture names are normalized before anything is compared", () => {
  it("treats the uname and Docker spellings of the same CPU as one", () => {
    // uname -m says x86_64, docker info says amd64. Comparing those literally would reject every host.
    assert.equal(canonicalArchitecture("x86_64"), "amd64");
    assert.equal(canonicalArchitecture("amd64"), "amd64");
    assert.equal(canonicalArchitecture("aarch64"), "arm64");
    assert.equal(canonicalArchitecture("arm64"), "arm64");
    assert.equal(compareArchitectures("x86_64", "amd64").compatible, true);
    assert.equal(compareArchitectures("aarch64", "arm64").compatible, true);
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(canonicalArchitecture("  AMD64  "), "amd64");
    assert.equal(canonicalArchitecture("X86_64"), "amd64");
    assert.equal(canonicalArchitecture("AArch64"), "arm64");
  });

  it("reduces a platform string to its architecture", () => {
    assert.equal(canonicalArchitecture("linux/arm64"), "arm64");
    assert.equal(canonicalArchitecture("linux/arm/v7"), "arm");
    assert.equal(canonicalArchitecture("linux/amd64"), "amd64");
  });

  it("keeps the 32-bit variants distinct from 64-bit ones", () => {
    // A 32-bit image does not run on a 64-bit-only target, and vice versa.
    assert.notEqual(canonicalArchitecture("armv7l"), canonicalArchitecture("arm64"));
    assert.notEqual(canonicalArchitecture("i386"), canonicalArchitecture("amd64"));
    assert.equal(compareArchitectures("armv7l", "arm64").compatible, false);
  });

  it("keeps the other real architectures distinct", () => {
    for (const architecture of ["ppc64le", "s390x", "riscv64", "386", "arm"]) {
      assert.equal(canonicalArchitecture(architecture), architecture);
    }
  });

  it("returns null for anything it cannot place, rather than guessing", () => {
    for (const value of ["", "   ", "sparc", "mips64", null, undefined, 42, {}]) {
      assert.equal(canonicalArchitecture(value), null, `${String(value)} must not be guessed`);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Comparison
// -------------------------------------------------------------------------------------------
describe("an image is compared against the host that must run it", () => {
  it("accepts a match and reports both canonical values", () => {
    const comparison = compareArchitectures("x86_64", "amd64");
    assert.equal(comparison.compatible, true);
    assert.equal(comparison.imageArchitecture, "amd64");
    assert.equal(comparison.serverArchitecture, "amd64");
    assert.equal(comparison.reason, undefined);
  });

  it("rejects a genuine mismatch", () => {
    const comparison = compareArchitectures("amd64", "arm64");
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.reason, "mismatch");
    assert.equal(comparison.imageArchitecture, "amd64");
    assert.equal(comparison.serverArchitecture, "arm64");
  });

  it("refuses when the image architecture cannot be read", () => {
    // "We could not tell" is not "it will work". Assuming compatibility here is the exact bug this
    // check exists to prevent.
    const comparison = compareArchitectures(null, "amd64");
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.reason, "image_unknown");
    assert.equal(comparison.serverArchitecture, "amd64");
  });

  it("refuses when the server architecture has never been probed", () => {
    const comparison = compareArchitectures("amd64", null);
    assert.equal(comparison.compatible, false);
    assert.equal(comparison.reason, "server_unknown");
    assert.equal(comparison.imageArchitecture, "amd64");
  });

  it("refuses when neither side is known", () => {
    const comparison = compareArchitectures(null, null);
    assert.equal(comparison.compatible, false);
    assert.ok(comparison.reason);
  });
});

// -------------------------------------------------------------------------------------------
// Structured errors
// -------------------------------------------------------------------------------------------
describe("a refusal is structured and actionable", () => {
  it("carries the code architecture_mismatch", () => {
    try {
      assertCompatibleArchitecture("amd64", "arm64");
      assert.fail("a mismatch must throw");
    } catch (error) {
      assert.ok(error instanceof ArchitectureMismatchError);
      assert.equal(error.code, "architecture_mismatch");
      assert.equal(error.status, 409);
      assert.equal(error.imageArchitecture, "amd64");
      assert.equal(error.serverArchitecture, "arm64");
    }
  });

  it("returns the canonical pair when compatible", () => {
    assert.deepEqual(assertCompatibleArchitecture("x86_64", "amd64"), { imageArchitecture: "amd64", serverArchitecture: "amd64" });
  });

  it("distinguishes an unprobed server from a real mismatch, because the fix differs", () => {
    let unknown;
    try {
      assertCompatibleArchitecture("amd64", null);
      assert.fail("an unknown server architecture must throw");
    } catch (error) {
      unknown = error;
    }
    assert.equal(unknown.code, "server_architecture_unknown");
    assert.match(unknown.message, /Re-test the server/);

    // The two refusals must not read the same: re-probing a server fixes one and does nothing for the
    // other, and telling an operator to rebuild when the server simply was never probed wastes a build.
    let mismatch;
    try {
      assertCompatibleArchitecture("amd64", "arm64");
      assert.fail("a real mismatch must throw");
    } catch (error) {
      mismatch = error;
    }
    assert.equal(mismatch.code, "architecture_mismatch");
    assert.doesNotMatch(mismatch.message, /Re-test the server/);
    assert.notEqual(unknown.message, mismatch.message);
  });

  it("names the remediation that applies to a real mismatch", () => {
    const message = architectureFailureReason(compareArchitectures("amd64", "arm64"), "amd64", "arm64", "edge-1");
    assert.match(message, /edge-1/);
    assert.match(message, /amd64/);
    assert.match(message, /arm64/);
    assert.match(message, /binfmt/);
    assert.match(message, /multi-platform/);
  });

  it("tells an unknown target to be probed rather than rebuilt", () => {
    const message = architectureFailureReason(compareArchitectures("amd64", null), "amd64", null, "edge-1");
    assert.match(message, /Re-test the server/);
    assert.doesNotMatch(message, /binfmt/);
  });

  it("describes the comparison without leaking anything", () => {
    assert.equal(describeArchitecture("x86_64", "amd64"), "image amd64 matches amd64");
    assert.equal(describeArchitecture("amd64", "aarch64"), "image amd64 does not match arm64");
    assert.equal(describeArchitecture(null, null), "image unknown does not match unknown");
    // The description is a status line only: no tag, no path, no credential.
    assert.doesNotMatch(describeArchitecture("amd64", "arm64"), /PRIVATE KEY|postgres:\/\/|[A-Za-z0-9+/]{32}/);
  });
});