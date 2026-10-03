import { readFile } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import type { DiskMetric } from "./types";

const ignored = new Set(["proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "cgroup", "cgroup2", "overlay", "squashfs", "nsfs", "autofs", "pstore", "debugfs", "tracefs", "securityfs", "configfs", "fusectl", "mqueue"]);
export async function getDiskMetrics(): Promise<DiskMetric[]> {
  const mounts = new Map<string, string>();
  for (const line of (await readFile("/proc/mounts", "utf8")).split("\n")) { const parts = line.split(" "); if (parts.length >= 3 && !ignored.has(parts[2]) && parts[1].startsWith("/") && !mounts.has(parts[1])) mounts.set(parts[1], parts[0]); }
  const results: DiskMetric[] = [];
  for (const [mountPoint, filesystem] of mounts) { try { const value = await statfs(mountPoint); const totalBytes = Number(value.blocks) * Number(value.bsize); const availableBytes = Number(value.bavail) * Number(value.bsize); const freeBytes = Number(value.bfree) * Number(value.bsize); if (!totalBytes) continue; results.push({ timestamp: new Date().toISOString(), filesystem, mountPoint, totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes), availableBytes, usagePercent: ((totalBytes - availableBytes) / totalBytes) * 100 }); } catch { /* Mounts can disappear between enumeration and statfs. */ } }
  return results.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint)).slice(0, 24);
}
