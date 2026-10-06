"use client";

import { readApiJson } from "@/lib/api/client";

import { useEffect, useState } from "react";

type Info = { serverVersion: string; apiVersion: string; containersRunning: number; containersStopped: number; images: number };
type Container = { id: string; name: string; image: string; status: string; state: string; created: string; ports: string };
type ErrorState = { code?: string; message?: string };

const formatDate = (value: string) => value ? new Date(value).toLocaleString() : "-";

async function fetchDockerData() {
  const [infoResponse, containerResponse] = await Promise.all([fetch("/api/docker/info", { cache: "no-store" }), fetch("/api/docker/containers", { cache: "no-store" })]);
  const [infoResult, containerResult] = await Promise.all([
    readApiJson<Info>(infoResponse),
    readApiJson<{ items?: Container[] }>(containerResponse),
  ]);
  if (!infoResult.ok) throw Object.assign(new Error(infoResult.error.message), infoResult.error);
  if (!containerResult.ok) throw Object.assign(new Error(containerResult.error.message), containerResult.error);
  return { info: infoResult.data, containers: containerResult.data.items || [] };
}

export default function DockerPhase3() {
  const [info, setInfo] = useState<Info | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorState | null>(null);

  const load = (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    fetchDockerData().then(({ info: nextInfo, containers: nextContainers }) => {
      setInfo(nextInfo);
      setContainers(nextContainers);
      setLoading(false);
    }).catch((reason: ErrorState) => { setError(reason); setLoading(false); });
  };

  useEffect(() => { fetchDockerData().then(({ info: nextInfo, containers: nextContainers }) => { setInfo(nextInfo); setContainers(nextContainers); setLoading(false); }).catch((reason: ErrorState) => { setError(reason); setLoading(false); }); }, []);
  return <div className="docker-page"><div className="page-header"><div><h1>Docker</h1><p>Containers running in the local workspace.</p></div><button className="secondary-button" onClick={() => load()} disabled={loading}>{loading ? "Refreshing" : "Refresh"}</button></div>{loading && <div className="panel state-block" role="status"><strong>Checking Docker</strong><span>Reading the local Docker daemon through the server.</span></div>}{!loading && error && <div className="github-state github-error" role="alert"><strong>{error.code === "permission_denied" ? "Docker access is not permitted" : error.code === "timeout" ? "Docker daemon timed out" : "Docker daemon is unavailable"}</strong><span>{error.message || "Start Docker and refresh this page."}</span><button className="secondary-button" onClick={() => load()}>Try again</button></div>}{!loading && !error && info && <><div className="docker-engine"><div><span className="status status-green"><span className="status-dot" />Docker engine available</span><strong>Docker {info.serverVersion}</strong></div><span>API {info.apiVersion}</span></div><section className="overview-grid docker-stats" aria-label="Docker summary"><DockerStat label="Running" value={info.containersRunning} /><DockerStat label="Stopped" value={info.containersStopped} /><DockerStat label="Images" value={info.images} /></section><section className="panel table-panel"><div className="panel-header"><h2>Containers</h2></div>{containers.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Container ID</th><th>Image</th><th>Status</th><th>State</th><th>Ports</th><th>Created</th></tr></thead><tbody>{containers.map((container) => <tr key={container.id}><td className="strong-cell">{container.name}</td><td className="mono-cell">{container.id.slice(0, 12)}</td><td className="mono-cell">{container.image}</td><td>{container.status}</td><td><span className={`status status-${container.state === "running" ? "green" : "yellow"}`}><span className="status-dot" />{container.state}</span></td><td className="mono-cell">{container.ports}</td><td className="muted-cell">{formatDate(container.created)}</td></tr>)}</tbody></table></div> : <div className="state-block"><strong>No containers found</strong><span>The Docker daemon returned an empty container list.</span></div>}</section></>}</div>;
}

function DockerStat({ label, value }: { label: string; value: number }) { return <div className="summary"><div className="summary-top"><span>{label}</span></div><div className="summary-value">{value}</div></div>; }
