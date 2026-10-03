import { getCpuMetrics } from "./cpu";
import { getDiskMetrics } from "./disk";
import { getGpuMetrics } from "./gpu";
import { getMemoryMetrics } from "./memory";
import { getNetworkMetrics } from "./network";
import { getSystemInfo } from "./system";
import { getTemperatureMetrics } from "./temperature";
import type { SystemOverview } from "./types";

export async function getSystemOverview(): Promise<SystemOverview> {
  const entries = await Promise.allSettled([getSystemInfo(), getCpuMetrics(), getMemoryMetrics(), getDiskMetrics(), getGpuMetrics(), getTemperatureMetrics(), getNetworkMetrics()]);
  const value = <T>(index: number): T | null => entries[index].status === "fulfilled" ? entries[index].value as T : null;
  const errors: SystemOverview["errors"] = {};
  const names = ["system", "cpu", "memory", "disk", "gpu", "temperature", "network"] as const;
  entries.forEach((entry, index) => { if (entry.status === "rejected") errors[names[index]] = "Metric unavailable"; });
  return { timestamp: new Date().toISOString(), system: value(0), cpu: value(1), memory: value(2), disk: value(3) || [], gpu: value(4), temperature: value(5), network: value(6) || [], errors };
}
