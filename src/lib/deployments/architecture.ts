// Deployment architecture compatibility.
//
// Phase 11 built the image locally and streamed it to the remote daemon. Nothing checked that the image
// would actually run there. An amd64 image pushed to an arm64 host produces a container that starts and
// then dies on the first instruction, which reads like an application failure and is not one.
//
// This module is pure and imports nothing, so the rules can be exercised directly. The Docker calls that
// read a real architecture live in docker.ts and remote/docker.ts.
//
// Cross-architecture deployment is deliberately not attempted here. Emulation would need registered
// binfmt handlers on the build host, and this one has none: /proc/sys/fs/binfmt_misc holds only the
// register and DOSWin entries. Claiming support for it without having built and run an image on each
// platform would be a claim rather than a capability, so a mismatch fails early with instructions instead.

export class ArchitectureMismatchError extends Error {
  code = "architecture_mismatch";
  status = 409;
  imageArchitecture: string;
  serverArchitecture: string;

  constructor(imageArchitecture: string, serverArchitecture: string) {
    super(
      `The built image is ${imageArchitecture} but ${serverArchitecture} runs it on a different CPU architecture. ` +
      `Build on a ${imageArchitecture} machine, or register binfmt emulation handlers on this host and use a ` +
      `multi-platform builder, before deploying to ${serverArchitecture}.`,
    );
    this.name = "ArchitectureMismatchError";
    this.imageArchitecture = imageArchitecture;
    this.serverArchitecture = serverArchitecture;
  }
}

// The canonical Go/Docker architecture names. `uname -m` and `docker info` disagree on the two most
// common ones, so both spellings must land on the same value before anything is compared.
const architectureAliases: Record<string, string> = {
  x86_64: "amd64", amd64: "amd64",
  aarch64: "arm64", arm64: "arm64", armv8: "arm64", armv8l: "arm64",
  arm: "arm", arm32: "arm", armv7l: "arm", armv7: "arm", armhf: "arm",
  armv6l: "arm", armv6: "arm", armel: "arm",
  i386: "386", i486: "386", i586: "386", i686: "386", x86: "386",
  ppc64le: "ppc64le", ppc64el: "ppc64le",
  s390x: "s390x",
  riscv64: "riscv64",
};

/**
 * Reduces an architecture name to its canonical Docker form, or null when it is unknown.
 *
 * `linux/arm/v7` from a platform string and `armv7l` from uname are the same thing, so the platform
 * string is split first. An unrecognised value is never guessed at: returning null makes the caller
 * report "unknown" instead of silently treating two different names as equal.
 */
// Every canonical name the alias map can produce. A value that is already canonical must resolve to
// itself, so `386` and `arm` are accepted and not just the aliases that point at them.
const canonicalArchitectures = new Set(Object.values(architectureAliases));

function resolve(bare: string): string | null {
  return architectureAliases[bare] ?? (canonicalArchitectures.has(bare) ? bare : null);
}

export function canonicalArchitecture(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!trimmed.includes("/")) return resolve(trimmed);

  // A platform string is `<os>/<arch>[/<variant>]`, where the variant is a version such as v7. The
  // architecture is the second segment, and the variant only ever disambiguates within one architecture,
  // so linux/arm/v7 is arm exactly as linux/amd64 is amd64.
  const segments = trimmed.split("/");
  const variant = segments[segments.length - 1];
  const architecture = /^v\d+$/.test(variant) ? segments[segments.length - 2] : variant;
  if (!architecture) return null;
  const canonical = resolve(architecture);
  if (!canonical || canonical !== "arm") return canonical;
  // arm is the one architecture with meaningful variants, so 32-bit vs 64-bit is preserved rather than
  // collapsed: a v7 image does not run where an arm64/v8 host expects it.
  if (variant === "v8" || variant === "v8l") return "arm64";
  return "arm";
}

export type ArchitectureComparison = {
  compatible: boolean;
  /** Canonical image architecture, or null when it could not be determined. */
  imageArchitecture: string | null;
  /** Canonical server architecture, or null when it could not be determined. */
  serverArchitecture: string | null;
  /** Why the deployment may not proceed. Absent when compatible. */
  reason?: "mismatch" | "image_unknown" | "server_unknown";
};

/**
 * Compares an image architecture against the architecture of the host that must run it.
 *
 * An unknown value on either side is reported rather than assumed compatible. "We could not tell" is
 * not the same as "it will work", and silently assuming it would reintroduce exactly the failure this
 * check exists to prevent.
 */
export function compareArchitectures(image: string | null | undefined, server: string | null | undefined): ArchitectureComparison {
  const imageArchitecture = canonicalArchitecture(image);
  const serverArchitecture = canonicalArchitecture(server);
  if (!imageArchitecture) return { compatible: false, imageArchitecture: null, serverArchitecture, reason: "image_unknown" };
  if (!serverArchitecture) return { compatible: false, imageArchitecture, serverArchitecture: null, reason: "server_unknown" };
  return {
    compatible: imageArchitecture === serverArchitecture,
    imageArchitecture,
    serverArchitecture,
    ...(imageArchitecture === serverArchitecture ? {} : { reason: "mismatch" as const }),
  };
}

/** Throws a structured `architecture_mismatch` unless the image can run on the target host. */
export function assertCompatibleArchitecture(image: string | null | undefined, server: string | null | undefined, targetName: string | null = null): { imageArchitecture: string; serverArchitecture: string } {
  const comparison = compareArchitectures(image, server);
  if (comparison.compatible) return { imageArchitecture: comparison.imageArchitecture as string, serverArchitecture: comparison.serverArchitecture as string };

  // The image is known but the target is not: that is a missing probe, not a genuine mismatch, so it gets
  // its own code and points at re-testing the server rather than at rebuilding anything.
  if (comparison.reason === "server_unknown") {
    const unknown = new Error(architectureFailureReason(comparison, image, server, targetName));
    Object.assign(unknown, {
      name: "ArchitectureUnknownError",
      code: "server_architecture_unknown",
      status: 409,
      imageArchitecture: comparison.imageArchitecture,
      serverArchitecture: null,
    });
    throw unknown;
  }
  if (comparison.reason === "image_unknown") {
    const unreadable = new Error(architectureFailureReason(comparison, image, server, targetName));
    Object.assign(unreadable, {
      name: "ArchitectureUnknownError",
      code: "image_architecture_unknown",
      status: 409,
      imageArchitecture: null,
      serverArchitecture: comparison.serverArchitecture,
    });
    throw unreadable;
  }
  throw new ArchitectureMismatchError(comparison.imageArchitecture as string, comparison.serverArchitecture as string);
}

/** A short, non-sensitive summary for logs and API responses. */
export function describeArchitecture(image: string | null | undefined, server: string | null | undefined) {
  const comparison = compareArchitectures(image, server);
  const imageText = comparison.imageArchitecture ?? "unknown";
  const serverText = comparison.serverArchitecture ?? "unknown";
  return comparison.compatible ? `image ${imageText} matches ${serverText}` : `image ${imageText} does not match ${serverText}`;
}

/**
 * The operator-facing explanation for a refusal, with the remediation that actually applies.
 *
 * Only architecture names are included. The target is named when it is known, because that is what makes
 * the message actionable, and nothing here reads or exposes a credential.
 */
export function architectureFailureReason(comparison: ArchitectureComparison, image: string | null | undefined, server: string | null | undefined, targetName: string | null) {
  const target = targetName ?? "the target host";
  const imageText = comparison.imageArchitecture ?? "unknown";
  const serverText = comparison.serverArchitecture ?? "unknown";

  if (comparison.reason === "image_unknown") {
    return `The architecture of the built image could not be determined, so it cannot be confirmed to run on ${target}.`;
  }
  if (comparison.reason === "server_unknown") {
    return `The built image is ${imageText}, but ${target}'s architecture has not been detected. Re-test the server connection so its architecture is recorded, then deploy again.`;
  }
  return `The built image is ${imageText}, but ${target} runs ${serverText}. An ${imageText} image cannot execute on ${serverText}. ` +
    `Deploy from a ${imageText} host, or register binfmt emulation handlers on the build host and use a multi-platform builder, ` +
    `before targeting ${serverText}.`;
}