import { readFile } from "node:fs/promises";
import type { MemoryMetrics } from "./types";

export async function getMemoryMetrics(): Promise<MemoryMetrics> {
  const values = new Map<string, number>();
  for (const line of (await readFile("/proc/meminfo", "utf8")).split("\n")) { const match = /^(\w+):\s+(\d+)/.exec(line); if (match) values.set(match[1], Number(match[2]) * 1024); }
  const totalBytes = values.get("MemTotal") || 0;
  const availableBytes = values.get("MemAvailable") ?? Math.max(0, totalBytes - (values.get("MemFree") || 0));
  const freeBytes = values.get("MemFree") || 0;
  const cachedBytes = (values.get("Cached") || 0) + (values.get("SReclaimable") || 0);
  const swapTotalBytes = values.get("SwapTotal") || 0;
  const swapFreeBytes = values.get("SwapFree") || 0;
  return { timestamp: new Date().toISOString(), totalBytes, usedBytes: Math.max(0, totalBytes - availableBytes), availableBytes, freeBytes, cachedBytes, usagePercent: totalBytes ? ((totalBytes - availableBytes) / totalBytes) * 100 : 0, swapTotalBytes, swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes), swapFreeBytes };
}
