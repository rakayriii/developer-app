import { readFile } from "node:fs/promises";
import os from "node:os";
import type { CpuMetrics } from "./types";

type CpuSample = { total: number; user: number; system: number; idle: number; cores: Map<string, { total: number; idle: number }> };
let previous: CpuSample | null = null;

async function readCpuSample(): Promise<CpuSample> {
  const text = await readFile("/proc/stat", "utf8");
  const cores = new Map<string, { total: number; idle: number }>();
  let aggregate = { total: 0, user: 0, system: 0, idle: 0 };
  for (const line of text.split("\n")) {
    const match = /^(cpu\d*|cpu)\s+(.+)$/.exec(line);
    if (!match) continue;
    const values = match[2].trim().split(/\s+/).map(Number);
    const user = (values[0] || 0) + (values[1] || 0);
    const system = (values[2] || 0) + (values[5] || 0) + (values[6] || 0);
    const idle = (values[3] || 0) + (values[4] || 0);
    const total = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    if (match[1] === "cpu") aggregate = { total, user, system, idle };
    else cores.set(match[1], { total, idle });
  }
  return { ...aggregate, cores };
}

function percentage(delta: number, total: number) { return total > 0 ? Math.max(0, Math.min(100, (delta / total) * 100)) : 0; }

export async function getCpuMetrics(): Promise<CpuMetrics> {
  const sample = await readCpuSample();
  const prior = previous;
  previous = sample;
  const totalDelta = prior ? sample.total - prior.total : 0;
  const idleDelta = prior ? sample.idle - prior.idle : 0;
  const userDelta = prior ? sample.user - prior.user : 0;
  const systemDelta = prior ? sample.system - prior.system : 0;
  const perCore = [...sample.cores].map(([name, value]) => { const old = prior?.cores.get(name); return old ? percentage((value.total - old.total) - (value.idle - old.idle), value.total - old.total) : 0; });
  const cpuinfo = await readFile("/proc/cpuinfo", "utf8");
  const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() || "Unknown CPU";
  const physicalIds = new Set<string>();
  for (const block of cpuinfo.split("\n\n")) { const physical = /physical id\s*:\s*(\S+)/.exec(block)?.[1]; const core = /core id\s*:\s*(\S+)/.exec(block)?.[1]; if (physical && core) physicalIds.add(`${physical}:${core}`); }
  let frequencyMHz: number | null = null;
  try { const frequency = Number((await readFile("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "utf8")).trim()); if (Number.isFinite(frequency)) frequencyMHz = Math.round(frequency / 1000); } catch { const value = Number(/cpu MHz\s*:\s*(\S+)/.exec(cpuinfo)?.[1]); if (Number.isFinite(value)) frequencyMHz = Math.round(value); }
  const load = os.loadavg() as [number, number, number];
  return { timestamp: new Date().toISOString(), usagePercent: percentage(totalDelta - idleDelta, totalDelta), userPercent: percentage(userDelta, totalDelta), systemPercent: percentage(systemDelta, totalDelta), idlePercent: percentage(idleDelta, totalDelta), logicalCores: sample.cores.size || os.cpus().length, physicalCores: physicalIds.size || null, model, frequencyMHz, loadAverage: load, perCore };
}
