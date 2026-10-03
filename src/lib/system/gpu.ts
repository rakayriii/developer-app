import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GpuMetrics } from "./types";

const run = promisify(execFile);
export async function getGpuMetrics(): Promise<GpuMetrics> {
  const timestamp = new Date().toISOString();
  try {
    const { stdout } = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.total,memory.used,memory.free,temperature.gpu,power.draw,driver_version", "--format=csv,noheader,nounits"], { timeout: 1500, maxBuffer: 16 * 1024 });
    const row = stdout.trim().split("\n")[0]?.split(",").map((part) => part.trim());
    if (!row || row.length < 8) return { timestamp, available: false, reason: "nvidia-smi returned no GPU data" };
    const number = (value: string) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; };
    const totalMiB = number(row[2] || ""); const usedMiB = number(row[3] || ""); const freeMiB = number(row[4] || "");
    return { timestamp, available: true, name: row[0], utilizationPercent: number(row[1] || ""), vramTotalBytes: totalMiB === undefined ? undefined : totalMiB * 1024 * 1024, vramUsedBytes: usedMiB === undefined ? undefined : usedMiB * 1024 * 1024, vramFreeBytes: freeMiB === undefined ? undefined : freeMiB * 1024 * 1024, temperatureCelsius: number(row[5] || ""), powerWatts: number(row[6] || ""), driverVersion: row[7] };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return { timestamp, available: false, reason: code === "ENOENT" ? "nvidia-smi is not available" : "NVIDIA GPU metrics are unavailable" };
  }
}
