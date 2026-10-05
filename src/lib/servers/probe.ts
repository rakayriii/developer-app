export type ServerProbeResult = { osName: string | null; osVersion: string | null; architecture: string | null; kernel: string | null; dockerVersion: string | null; dockerAvailable: boolean; cpuCount: number | null; memoryBytes: bigint | null; diskBytes: bigint | null; diskFreeBytes: bigint | null };

const architectureMap: Record<string, string> = { x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64", armv7l: "arm", armv6l: "arm", i386: "386", i686: "386", ppc64le: "ppc64le", s390x: "s390x", riscv64: "riscv64" };

export function normalizeArchitecture(value: string | null) {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  return architectureMap[key] || key.slice(0, 24);
}

// The os probe emits "PRETTY_NAME|VERSION_ID" on a single line, which keeps a value such as
// "Ubuntu 24.04.1 LTS" intact. A raw /etc/os-release dump is also accepted.
// The os probe emits sorted "KEY=value" pairs joined by "|", so a value containing spaces stays
// intact. PRETTY_NAME wins over the bare NAME field, and VERSION_ID supplies the version.
export function parseOsRelease(value: string) {
  const result = { osName: null as string | null, osVersion: null as string | null };
  const clean = (input: string) => input.replace(/^"|"$/g, "").trim();
  for (const entry of value.split("|")) {
    const separator = entry.indexOf("=");
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    const content = clean(entry.slice(separator + 1));
    if (!content) continue;
    if (key === "NAME" && !result.osName) result.osName = content.slice(0, 80);
    else if (key === "VERSION_ID" && !result.osVersion) result.osVersion = content.slice(0, 40);
    else if (key === "PRETTY_NAME") result.osName = content.slice(0, 80);
  }
  return result;
}

export function parsePositiveInt(value: string | null, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) return null;
  return parsed;
}

export function parseDisk(value: string | null) {
  if (!value) return { diskBytes: null, diskFreeBytes: null };
  const [size, avail] = value.trim().split(/\s+/);
  return { diskBytes: parseBigInt(size), diskFreeBytes: parseBigInt(avail) };
}

function parseBigInt(value: string | undefined) {
  if (!value) return null;
  // Remote output is untrusted: a non-numeric df or /proc value must degrade to null, not throw.
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = BigInt(value.trim());
  return parsed > BigInt(0) ? parsed : null;
}

export function parseDockerVersion(value: string | null) {
  if (!value) return { dockerAvailable: false, dockerVersion: null };
  const trimmed = value.trim();
  if (!trimmed || trimmed === "NONE") return { dockerAvailable: false, dockerVersion: null };
  return { dockerAvailable: true, dockerVersion: trimmed.slice(0, 40) };
}

export function assembleProbeResult(raw: { os: string; arch: string; kernel: string; cpu: string; memory: string; disk: string; docker: string }): ServerProbeResult {
  const os = parseOsRelease(raw.os);
  const disk = parseDisk(raw.disk);
  const docker = parseDockerVersion(raw.docker);
  return {
    osName: os.osName,
    osVersion: os.osVersion,
    architecture: normalizeArchitecture(raw.arch),
    kernel: raw.kernel ? raw.kernel.slice(0, 120) : null,
    dockerVersion: docker.dockerVersion,
    dockerAvailable: docker.dockerAvailable,
    cpuCount: parsePositiveInt(raw.cpu, 4096),
    memoryBytes: parseBigInt(raw.memory),
    diskBytes: disk.diskBytes,
    diskFreeBytes: disk.diskFreeBytes,
  };
}
