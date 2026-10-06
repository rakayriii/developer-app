"use client";

import { readApiJson } from "@/lib/api/client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Server = { id: string; name: string; hostname: string; port: number; username: string; authMethod: string; credentialConfigured: boolean; credentialFingerprint: string | null; hostKeyFingerprint: string | null; hostKeyTrusted: boolean; status: string; statusCode: string | null; statusMessage: string | null; osName: string | null; osVersion: string | null; architecture: string | null; kernel: string | null; dockerVersion: string | null; dockerAvailable: boolean; cpuCount: number | null; memoryBytes: number | null; diskBytes: number | null; diskFreeBytes: number | null; lastCheckedAt: string | null; lastConnectedAt: string | null; lastError: string | null; createdAt: string };
type Check = { id: string; status: string; code: string | null; message: string | null; hostKeyFingerprint: string | null; hostKeyTrusted: boolean; durationMs: number | null; createdAt: string };
type Section = "overview" | "connection" | "system" | "docker" | "checks";

const sections: { id: Section; label: string }[] = [{ id: "overview", label: "Overview" }, { id: "connection", label: "Connection" }, { id: "system", label: "System" }, { id: "docker", label: "Docker" }, { id: "checks", label: "Recent Checks" }];
const bytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0; let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
};
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "never");

export default function ServerDetail({ serverId }: { serverId: string }) {
  const router = useRouter();
  const [server, setServer] = useState<Server | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [section, setSection] = useState<Section>("overview");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const keyInput = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [serverResponse, checkResponse] = await Promise.all([fetch(`/api/servers/${serverId}`, { cache: "no-store" }), fetch(`/api/servers/${serverId}/checks`, { cache: "no-store" })]);
      const serverResult = await readApiJson<Server>(serverResponse);
      if (!serverResult.ok) throw new Error(serverResult.error.message);
      const body = serverResult.data;
      setServer(body as Server);
      const checkResult = await readApiJson<{ items: Check[] }>(checkResponse);
      if (checkResult.ok) setChecks(checkResult.data.items);
      setState("ready");
      setError("");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Server could not be loaded.");
    }
  }, [serverId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  // Conservative 60s polling; only while the page is visible.
  useEffect(() => {
    const tick = async () => {
      if (document.hidden || busy) return;
      try {
        const response = await fetch(`/api/servers/${serverId}`, { cache: "no-store" });
        const result = await readApiJson<Server>(response);
        if (result.ok) setServer(result.data);
      } catch { /* keep the last known state */ }
    };
    const interval = window.setInterval(tick, 60000);
    return () => window.clearInterval(interval);
  }, [serverId, busy]);

  const act = async (action: "test" | "refresh" | "trust") => {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/servers/${serverId}/${action}`, { method: "POST" });
      const actionResult = await readApiJson<{ hostKeyFingerprint?: string; server?: { status: string }; check?: { status: string } }>(response);
      if (!actionResult.ok) throw new Error(actionResult.error.message);
      const body = actionResult.data;
      setNotice(action === "trust" ? `Host key trusted: ${body.hostKeyFingerprint || "recorded"}.` : `${action} finished with status ${body.server?.status || body.check?.status || "unknown"}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${action} failed.`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rotateKey = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/servers/${serverId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ privateKey: keyDraft }) });
      const credentialResult = await readApiJson<Server>(response);
      if (!credentialResult.ok) throw new Error(credentialResult.error.message);
      setKeyDraft("");
      setEditOpen(false);
      if (keyInput.current) keyInput.current.value = "";
      setNotice("Private key replaced and re-encrypted.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Private key could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!server || !window.confirm(`Remove ${server.name}? The stored credential is deleted. Nothing on the remote host is changed.`)) return;
    const response = await fetch(`/api/servers/${server.id}`, { method: "DELETE" });
    const result = await readApiJson<unknown>(response);
    if (!result.ok) { setError(result.error.message); return; }
    router.push("/servers");
    router.refresh();
  };

  if (state === "loading") return <div className="server-workspace"><div className="page-header"><div><h1>Server</h1><p>Loading.</p></div></div></div>;
  if (state === "error" || !server) return <div className="server-workspace"><div className="page-header"><div><h1>Server</h1><p>{error}</p></div><Link className="secondary-button" href="/servers">Back</Link></div><div className="git-banner" role="alert"><strong>Server unavailable</strong><span>{error}</span></div></div>;

  return <div className="server-workspace">
    <div className="page-header"><div><div className="deployment-breadcrumb"><Link href="/servers">Servers</Link><span>/</span><span>{server.name}</span></div><h1>{server.name}</h1><p><code>{server.username}@{server.hostname}:{server.port}</code></p></div><div className="page-header-actions"><span className={`server-status server-status-${server.status}`}>{server.status}</span><Link className="secondary-button" href="/servers">All servers</Link></div></div>

    {error && <div className="git-banner" role="alert"><strong>Operation failed</strong><span>{error}</span></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}

    <div className="deployment-actions deployment-action-bar">
      {!server.hostKeyTrusted && <button className="primary-button" onClick={() => void act("trust")} disabled={busy}>Trust host key</button>}
      <button className="secondary-button" onClick={() => void act("test")} disabled={busy || !server.hostKeyTrusted}>Test connection</button>
      <button className="secondary-button" onClick={() => void act("refresh")} disabled={busy}>Refresh</button>
      <button className="secondary-button" onClick={() => setEditOpen((value) => !value)} disabled={busy}>Edit credential</button>
      <button className="secondary-button danger-button" onClick={() => void remove()} disabled={busy}>Remove</button>
    </div>

    {server.lastError && <div className="git-banner"><strong>{server.statusCode || "connection"}</strong><span>{server.lastError}</span></div>}

    {editOpen && <section className="git-section"><div className="git-section-header"><h2>Replace private key</h2><span className="form-note">The current key is never displayed.</span></div><form className="project-form" onSubmit={rotateKey}><label>New private key<textarea required rows={6} value={keyDraft} onChange={(event) => setKeyDraft(event.target.value)} spellCheck={false} autoComplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" ref={keyInput} /><span className="form-note">Sent once over this authenticated connection, encrypted immediately, then cleared.</span></label><div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setEditOpen(false); setKeyDraft(""); }}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>Save key</button></div></form></section>}

    <nav className="deployment-tabs">{sections.map((item) => <button key={item.id} className={`deployment-tab ${section === item.id ? "active" : ""}`} onClick={() => setSection(item.id)}>{item.label}</button>)}</nav>

    {section === "overview" && <section className="git-section"><div className="deployment-facts deployment-facts-dense">
      {([["Name", server.name], ["Status", server.status], ["Status code", server.statusCode || "—"], ["Status detail", server.statusMessage || "—"], ["Operating system", server.osName || "Not probed"], ["OS version", server.osVersion || "—"], ["Architecture", server.architecture || "Not probed"], ["Kernel", server.kernel || "Not probed"], ["CPU cores", server.cpuCount === null ? "Not probed" : String(server.cpuCount)], ["Memory", bytes(server.memoryBytes)], ["Disk total", bytes(server.diskBytes)], ["Disk free", bytes(server.diskFreeBytes)], ["Docker", server.dockerAvailable ? server.dockerVersion || "present" : "unavailable"], ["Last checked", when(server.lastCheckedAt)], ["Last connected", when(server.lastConnectedAt)], ["Registered", when(server.createdAt)]] as [string, string][]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div></section>}

    {section === "connection" && <section className="git-section"><div className="deployment-facts deployment-facts-dense">
      {([["Hostname", server.hostname], ["SSH port", String(server.port)], ["Username", server.username], ["Auth method", server.authMethod === "key" ? "SSH private key" : server.authMethod], ["Private key", server.credentialConfigured ? "Configured" : "Not configured"], ["Credential fingerprint", server.credentialFingerprint || "—"], ["Host key fingerprint", server.hostKeyFingerprint || "Not trusted"], ["Host key trusted", server.hostKeyTrusted ? "Yes" : "No"]] as [string, string][]).map(([label, value]) => <div key={label}><span>{label}</span><strong className={label.includes("fingerprint") || label === "Hostname" ? "mono" : ""}>{value}</strong></div>)}
    </div><p className="form-note server-detail-note">Credentials are stored encrypted with AES-256-GCM. The private key, its ciphertext, and any decrypted value are never returned by the API or written to a log.</p></section>}

    {section === "system" && <section className="git-section"><div className="deployment-facts deployment-facts-dense">
      {([["Operating system", server.osName || "Not probed"], ["Version", server.osVersion || "—"], ["Architecture", server.architecture || "Not probed"], ["Kernel", server.kernel || "Not probed"], ["CPU cores", server.cpuCount === null ? "Not probed" : String(server.cpuCount)], ["Memory", bytes(server.memoryBytes)], ["Disk total", bytes(server.diskBytes)], ["Disk free", bytes(server.diskFreeBytes)]] as [string, string][]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div></section>}

    {section === "docker" && <section className="git-section"><div className="deployment-facts deployment-facts-dense">
      {([["Docker available", server.dockerAvailable ? "Yes" : "No"], ["Docker version", server.dockerVersion || "—"], ["Last probed", when(server.lastCheckedAt)]] as [string, string][]).map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div><p className="form-note server-detail-note">This phase only reads the Docker version. No images are built and no containers are created on a remote host.</p></section>}

    {section === "checks" && <section className="git-section"><div className="git-section-header"><h2>Recent checks</h2><span>{checks.length} recorded</span></div>
      {checks.length ? <div className="server-check-list">{checks.map((check) => <div className="server-check-row" key={check.id}><span className={`server-status server-status-${check.status}`}>{check.status}</span><strong>{check.code || "ok"}</strong><span>{check.message || "—"}</span><span>{check.durationMs === null ? "" : `${check.durationMs} ms`}</span><time>{new Date(check.createdAt).toLocaleString()}</time></div>)}</div> : <div className="git-empty">No connection checks recorded yet.</div>}
    </section>}
  </div>;
}
