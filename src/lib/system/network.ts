import os from "node:os";
import { readFile } from "node:fs/promises";
import type { NetworkMetric } from "./types";

type Counter = { received: number; transmitted: number; timestamp: number };
const previous = new Map<string, Counter>();
export async function getNetworkMetrics(): Promise<NetworkMetric[]> {
  const now = Date.now();
  const interfaces = os.networkInterfaces();
  const results: NetworkMetric[] = [];
  for (const line of (await readFile("/proc/net/dev", "utf8")).split("\n").slice(2)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line); if (!match) continue;
    const name = match[1].trim(); if (name === "lo") continue;
    const values = match[2].trim().split(/\s+/).map(Number); const received = values[0] || 0; const transmitted = values[8] || 0; const old = previous.get(name); const seconds = old ? Math.max((now - old.timestamp) / 1000, 0.001) : 0;
    previous.set(name, { received, transmitted, timestamp: now });
    results.push({ timestamp: new Date(now).toISOString(), interface: name, state: (await readFile(`/sys/class/net/${name}/operstate`, "utf8").catch(() => "unknown")).trim(), receivedBytes: received, transmittedBytes: transmitted, receivedRateBytes: old ? Math.max(0, (received - old.received) / seconds) : 0, transmittedRateBytes: old ? Math.max(0, (transmitted - old.transmitted) / seconds) : 0, addresses: (interfaces[name] || []).filter((address) => address.family === "IPv4").map((address) => address.address) });
  }
  return results.sort((a, b) => a.interface.localeCompare(b.interface));
}
