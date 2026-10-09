"use client";

import { readApiJson } from "@/lib/api/client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GpuMetrics, ProcessPage, SystemOverview, TemperatureMetrics } from "@/lib/system/types";
import ReliabilitySummary from "@/components/reliability-summary";

const emptyOverview: SystemOverview = { timestamp: "", system: null, cpu: null, memory: null, disk: [], gpu: null, temperature: null, network: [], errors: {} };
const bytes = (value: number | undefined) => { if (value === undefined || !Number.isFinite(value)) return "Unavailable"; if (value < 1024) return `${value.toFixed(0)} B`; const units = ["KB", "MB", "GB", "TB"]; let amount = value; let index = -1; do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1); return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[index]}`; };
const percent = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "Unavailable" : `${value.toFixed(1)}%`;
const rate = (value: number) => `${bytes(value)}/s`;
const duration = (seconds: number) => { const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600); const minutes = Math.floor((seconds % 3600) / 60); return `${days ? `${days}d ` : ""}${hours}h ${minutes}m`; };

function Chart({ values, label }: { values: number[]; label: string }) {
  const points = values.length > 1 ? values.map((value, index) => `${(index / (values.length - 1)) * 100},${100 - Math.max(0, Math.min(100, value))}`).join(" ") : "0,100 100,100";
  return <svg className="system-chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={label}><polyline points={points} vectorEffect="non-scaling-stroke" /></svg>;
}

function Section({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) { return <section className={`system-section ${className}`}><div className="system-section-header"><h2>{title}</h2></div>{children}</section>; }
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div className="system-metric"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>; }

export default function SystemWorkspace() {
  const [overview, setOverview] = useState<SystemOverview>(emptyOverview);
  const [processes, setProcesses] = useState<ProcessPage | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [memoryHistory, setMemoryHistory] = useState<number[]>([]);
  const [state, setState] = useState<"loading" | "live" | "error" | "disconnected">("loading");
  const [error, setError] = useState("");
  const [sort, setSort] = useState<"cpu" | "memory" | "pid" | "name">("cpu");

  const loadOverview = useCallback(async () => {
    try { const response = await fetch("/api/system/overview", { cache: "no-store" }); const result = await readApiJson<SystemOverview>(response); if (result.status === 401) { setState("disconnected"); setError(result.ok ? "Connect GitHub to view system metrics." : result.error.message); return; } if (!result.ok) throw new Error(result.error.message); const body = result.data; setOverview(body); setState("live"); setError(""); if (body.cpu) setCpuHistory((history) => [...history, body.cpu?.usagePercent || 0].slice(-60)); if (body.memory) setMemoryHistory((history) => [...history, body.memory?.usagePercent || 0].slice(-60)); } catch (reason) { setState("error"); setError(reason instanceof Error ? reason.message : "System metrics could not be loaded."); }
  }, []);
  const loadProcesses = useCallback(async () => { try { const response = await fetch(`/api/system/processes?sort=${sort}&page=1&limit=50`, { cache: "no-store" }); const result = await readApiJson<ProcessPage>(response); if (result.ok) setProcesses(result.data); } catch { /* The overview remains useful when processes are unavailable. */ } }, [sort]);
  useEffect(() => { const initial = window.setTimeout(() => void loadOverview(), 0); const interval = window.setInterval(() => void loadOverview(), 2000); return () => { window.clearTimeout(initial); window.clearInterval(interval); }; }, [loadOverview]);
  useEffect(() => { const initial = window.setTimeout(() => void loadProcesses(), 0); const interval = window.setInterval(() => void loadProcesses(), 4000); return () => { window.clearTimeout(initial); window.clearInterval(interval); }; }, [loadProcesses]);

  const cpu = overview.cpu; const memory = overview.memory; const system = overview.system; const gpu = overview.gpu; const temperature = overview.temperature; const network = overview.network;
  const lastUpdated = overview.timestamp ? new Date(overview.timestamp).toLocaleTimeString() : "Waiting for measurement";
  const disk = overview.disk;
  const totalNetwork = useMemo(() => network.reduce((sum, item) => sum + item.receivedRateBytes + item.transmittedRateBytes, 0), [network]);
  return <div className="system-workspace"><div className="page-header system-page-header"><div><h1>System</h1><p>Live metrics from the Developer OS host.</p></div><div className={`system-connection system-connection-${state}`}><span className="status-dot" />{state === "live" ? "Live" : state === "loading" ? "Updating" : state === "disconnected" ? "Disconnected" : "Error"}<small>{lastUpdated}</small></div></div>{error && <div className="system-banner" role="alert"><strong>{state === "disconnected" ? "Authentication required" : "Monitoring unavailable"}</strong><span>{error}</span>{state === "error" && <button className="text-button" onClick={() => void loadOverview()}>Retry</button>}</div>}
    <ReliabilitySummary />
    <div className="system-grid"><Section title="CPU" className="system-cpu"><div className="system-metric-grid"><Metric label="Usage" value={percent(cpu?.usagePercent)} detail={cpu ? `user ${percent(cpu.userPercent)} · system ${percent(cpu.systemPercent)}` : undefined} /><Metric label="Load average" value={cpu ? cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ") : "Unavailable"} detail="1 / 5 / 15 min" /><Metric label="Cores" value={cpu ? `${cpu.logicalCores}${cpu.physicalCores ? ` / ${cpu.physicalCores}` : ""}` : "Unavailable"} detail="logical / physical" /><Metric label="Frequency" value={cpu?.frequencyMHz ? `${cpu.frequencyMHz} MHz` : "Unavailable"} /></div><Chart values={cpuHistory} label="CPU usage history" /></Section>
      <Section title="Memory" className="system-memory"><div className="system-metric-grid"><Metric label="Used" value={bytes(memory?.usedBytes)} detail={percent(memory?.usagePercent)} /><Metric label="Available" value={bytes(memory?.availableBytes)} /><Metric label="Free" value={bytes(memory?.freeBytes)} /><Metric label="Swap" value={memory ? `${bytes(memory.swapUsedBytes)} / ${bytes(memory.swapTotalBytes)}` : "Unavailable"} detail="used / total" /></div><Chart values={memoryHistory} label="Memory usage history" /></Section>
    </div>
    <Section title="Host"><div className="system-host-grid"><Metric label="Hostname" value={system?.hostname || "Unavailable"} /><Metric label="Operating system" value={system?.operatingSystem || "Unavailable"} /><Metric label="Kernel" value={system?.kernel || "Unavailable"} /><Metric label="Architecture" value={system?.architecture || "Unavailable"} /><Metric label="Uptime" value={system ? duration(system.uptimeSeconds) : "Unavailable"} /><Metric label="Total RAM" value={bytes(system?.totalMemoryBytes)} /></div></Section>
    <Section title="Disk"><div className="system-table-wrap"><table className="system-table"><thead><tr><th>Filesystem</th><th>Mount</th><th>Used</th><th>Available</th><th>Usage</th></tr></thead><tbody>{disk.length ? disk.map((item) => <tr key={`${item.filesystem}-${item.mountPoint}`}><td title={item.filesystem}>{item.filesystem}</td><td>{item.mountPoint}</td><td>{bytes(item.usedBytes)}</td><td>{bytes(item.availableBytes)}</td><td><div className="system-bar"><span style={{ width: `${Math.min(100, item.usagePercent)}%` }} /></div>{percent(item.usagePercent)}</td></tr>) : <tr><td colSpan={5}>Disk data unavailable</td></tr>}</tbody></table></div></Section>
    <div className="system-grid"><Section title="GPU"><Gpu gpu={gpu} /></Section><Section title="Temperatures"><Temperatures metrics={temperature} /></Section></div>
    <Section title="Network"><div className="system-network-total">Current transfer rate: {rate(totalNetwork)}</div><div className="system-table-wrap"><table className="system-table"><thead><tr><th>Interface</th><th>State</th><th>Address</th><th>Received</th><th>Transmitted</th><th>Rate</th></tr></thead><tbody>{network.length ? network.map((item) => <tr key={item.interface}><td>{item.interface}</td><td>{item.state}</td><td>{item.addresses.join(", ") || "-"}</td><td>{bytes(item.receivedBytes)}</td><td>{bytes(item.transmittedBytes)}</td><td>{rate(item.receivedRateBytes)} / {rate(item.transmittedRateBytes)}</td></tr>) : <tr><td colSpan={6}>Network data unavailable</td></tr>}</tbody></table></div></Section>
    <Section title="Processes"><div className="system-process-toolbar"><span>{processes ? `${processes.total} processes` : "Updating processes"}</span><label>Sort <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="cpu">CPU</option><option value="memory">Memory</option><option value="pid">PID</option><option value="name">Name</option></select></label></div><div className="system-table-wrap"><table className="system-table"><thead><tr><th>PID</th><th>Name</th><th>CPU</th><th>Memory</th><th>Status</th><th>User</th></tr></thead><tbody>{processes?.items.length ? processes.items.map((item) => <tr key={item.pid}><td>{item.pid}</td><td>{item.name}</td><td>{percent(item.cpuPercent)}</td><td>{bytes(item.memoryBytes)} ({percent(item.memoryPercent)})</td><td>{item.status}</td><td>{item.user}</td></tr>) : <tr><td colSpan={6}>{state === "loading" ? "Loading processes" : "Process data unavailable"}</td></tr>}</tbody></table></div></Section>
  </div>;
}

function Gpu({ gpu }: { gpu: GpuMetrics | null }) { if (!gpu?.available) return <div className="system-unavailable"><strong>GPU not available</strong><span>{gpu?.reason || "No supported NVIDIA GPU detected."}</span></div>; return <div className="system-host-grid"><Metric label="Device" value={gpu.name || "NVIDIA GPU"} /><Metric label="Utilization" value={percent(gpu.utilizationPercent)} /><Metric label="VRAM" value={`${bytes(gpu.vramUsedBytes)} / ${bytes(gpu.vramTotalBytes)}`} detail="used / total" /><Metric label="Temperature" value={gpu.temperatureCelsius === undefined ? "Unavailable" : `${gpu.temperatureCelsius} °C`} /><Metric label="Power" value={gpu.powerWatts === undefined ? "Unavailable" : `${gpu.powerWatts.toFixed(1)} W`} /><Metric label="Driver" value={gpu.driverVersion || "Unavailable"} /></div>; }
function Temperatures({ metrics }: { metrics: TemperatureMetrics | null }) { if (!metrics?.available) return <div className="system-unavailable"><strong>Temperature data unavailable</strong><span>{metrics?.reason || "No readable Linux hardware sensors were found."}</span></div>; return <div className="system-host-grid">{metrics.sensors.map((sensor) => <Metric key={`${sensor.source}-${sensor.name}`} label={sensor.name} value={`${sensor.temperatureCelsius} °C`} />)}</div>; }
