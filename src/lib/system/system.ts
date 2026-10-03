import os from "node:os";
import { readFile } from "node:fs/promises";
import type { SystemInfo } from "./types";

export async function getSystemInfo(): Promise<SystemInfo> {
  const [release, meminfo, cpuinfo] = await Promise.all([readFile("/etc/os-release", "utf8").catch(() => ""), readFile("/proc/meminfo", "utf8").catch(() => ""), readFile("/proc/cpuinfo", "utf8").catch(() => "")]);
  const operatingSystem = /PRETTY_NAME="?([^"\n]+)"?/.exec(release)?.[1] || os.platform();
  const cpuModel = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() || "Unknown CPU";
  const uptimeSeconds = os.uptime();
  const totalMemoryBytes = Number(/^MemTotal:\s+(\d+)/m.exec(meminfo)?.[1] || 0) * 1024;
  return { timestamp: new Date().toISOString(), hostname: os.hostname(), operatingSystem, kernel: os.release(), architecture: os.arch(), uptimeSeconds, bootTime: new Date(Date.now() - uptimeSeconds * 1000).toISOString(), cpuModel, totalMemoryBytes };
}
