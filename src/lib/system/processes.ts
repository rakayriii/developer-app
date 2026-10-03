import { readdir, readFile } from "node:fs/promises";
import type { ProcessMetric, ProcessPage, ProcessSort } from "./types";

type Snapshot = { ticks: number; timestamp: number };
const previous = new Map<number, Snapshot>();
let previousTotal: { ticks: number; timestamp: number } | null = null;
let users: Map<string, string> | null = null;
const pageLimit = (value: number) => Math.max(1, Math.min(100, value));

async function totalCpuTicks() { const line = (await readFile("/proc/stat", "utf8")).split("\n")[0] || ""; return line.trim().split(/\s+/).slice(1).reduce((sum, value) => sum + (Number(value) || 0), 0); }
export async function getProcessMetrics(sort: ProcessSort = "cpu", page = 1, limit = 50): Promise<ProcessPage> {
  const now = Date.now(); const totalTicks = await totalCpuTicks(); const oldTotal = previousTotal; previousTotal = { ticks: totalTicks, timestamp: now }; const totalDelta = oldTotal ? Math.max(1, totalTicks - oldTotal.ticks) : 1;
  const entries = await readdir("/proc"); const processes: ProcessMetric[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8"); const close = stat.lastIndexOf(")"); const fields = stat.slice(close + 2).split(" "); const name = stat.slice(stat.indexOf("(") + 1, close); const state = fields[0] || "?"; const ticks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0); const old = previous.get(pid); previous.set(pid, { ticks, timestamp: now }); const cpuPercent = old ? Math.max(0, Math.min(100, ((ticks - old.ticks) / totalDelta) * 100)) : 0; const statusText = await readFile(`/proc/${pid}/status`, "utf8"); const uid = /^Uid:\s+(\d+)/m.exec(statusText)?.[1]; if (!users) users = new Map((await readFile("/etc/passwd", "utf8").catch(() => "")).split("\n").flatMap((line) => { const parts = line.split(":"); return parts[2] && parts[0] ? [[parts[2], parts[0]] as [string, string]] : []; })); const user = uid ? users.get(uid) || uid : "unknown"; const rss = Number(fields[21]) || 0; const memoryBytes = rss * 4096; processes.push({ pid, name: name.slice(0, 120), cpuPercent, memoryBytes, memoryPercent: 0, status: state, user });
    } catch { /* Processes may exit during enumeration. */ }
  }
  const totalMemory = Number((await readFile("/proc/meminfo", "utf8")).match(/^MemTotal:\s+(\d+)/m)?.[1] || 0) * 1024;
  for (const process of processes) process.memoryPercent = totalMemory ? (process.memoryBytes / totalMemory) * 100 : 0;
  const compare: Record<ProcessSort, (a: ProcessMetric, b: ProcessMetric) => number> = { cpu: (a, b) => b.cpuPercent - a.cpuPercent, memory: (a, b) => b.memoryBytes - a.memoryBytes, pid: (a, b) => a.pid - b.pid, name: (a, b) => a.name.localeCompare(b.name) };
  processes.sort(compare[sort]); const safePage = Math.max(1, page); const safeLimit = pageLimit(limit); return { timestamp: new Date().toISOString(), items: processes.slice((safePage - 1) * safeLimit, safePage * safeLimit), page: safePage, limit: safeLimit, total: processes.length, sort };
}
