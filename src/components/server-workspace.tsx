"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Server = { id: string; name: string; hostname: string; port: number; username: string; authMethod: string; credentialConfigured: boolean; credentialFingerprint: string | null; hostKeyFingerprint: string | null; hostKeyTrusted: boolean; status: string; statusCode: string | null; statusMessage: string | null; osName: string | null; osVersion: string | null; architecture: string | null; kernel: string | null; dockerVersion: string | null; dockerAvailable: boolean; cpuCount: number | null; memoryBytes: number | null; diskBytes: number | null; diskFreeBytes: number | null; lastCheckedAt: string | null; lastConnectedAt: string | null; lastError: string | null };
type FormState = { name: string; hostname: string; port: string; username: string; privateKey: string };

const emptyForm: FormState = { name: "", hostname: "", port: "22", username: "", privateKey: "" };
const bytes = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0; let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
};
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : "never");

export default function ServerWorkspace() {
  const [items, setItems] = useState<Server[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/servers", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Servers could not be loaded.");
      setItems((body.items || []) as Server[]);
      setState("ready");
      setError("");
    } catch (reason) {
      setState("error");
      setError(reason instanceof Error ? reason.message : "Servers could not be loaded.");
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const update = (key: keyof FormState, value: string) => setForm((current) => ({ ...current, [key]: value }));

  const addServer = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy("add");
    setError("");
    try {
      const response = await fetch("/api/servers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: form.name, hostname: form.hostname, port: Number(form.port), username: form.username, authMethod: "key", privateKey: form.privateKey }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || "Server could not be added.");
      // The private key is never kept in component state after submission.
      setForm(emptyForm);
      setFormOpen(false);
      setNotice(`${body.name} added. Trust its host key before the first connection test.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Server could not be added.");
    } finally {
      setBusy("");
    }
  };

  const act = async (server: Server, action: "test" | "refresh" | "trust" | "remove") => {
    if (action === "remove" && !window.confirm(`Remove ${server.name}? This deletes the stored credential. Nothing on the remote host is touched.`)) return;
    if ((action === "test" || action === "refresh" || action === "trust") && !window.confirm(`${action === "trust" ? "Trust" : action === "test" ? "Test connection to" : "Re-probe"} ${server.name}?`)) return;
    setBusy(`${action}:${server.id}`);
    setError(""); setNotice("");
    try {
      if (action === "remove") {
        const response = await fetch(`/api/servers/${server.id}`, { method: "DELETE" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || "Server could not be removed.");
        setNotice(`${server.name} removed.`);
      } else {
        const response = await fetch(`/api/servers/${server.id}/${action}`, { method: "POST" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message || `${action} failed.`);
        setNotice(action === "trust" ? `Host key trusted: ${body.hostKeyFingerprint || "recorded"}.` : `${action} finished: ${body.server?.status || body.check?.status || "done"}.`);
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${action} failed.`);
      await load();
    } finally {
      setBusy("");
    }
  };

  return <div className="server-workspace">
    <div className="page-header"><div><h1>Servers</h1><p>Remote Linux hosts reachable over SSH. Registration, verification, and monitoring only.</p></div><div className="page-header-actions"><div className={`git-connection status-${state === "ready" ? "green" : state === "error" ? "yellow" : "blue"}`}><span className="status-dot" />{state === "ready" ? "Ready" : state === "loading" ? "Loading" : "Error"}</div><button className="primary-button" onClick={() => { setForm(emptyForm); setFormOpen(true); setError(""); }}>Add Server</button></div></div>

    {error && <div className="git-banner" role="alert"><strong>Server operation failed</strong><span>{error}</span><button className="text-button" onClick={() => void load()}>Retry</button></div>}
    {notice && <div className="git-success" role="status">{notice}</div>}

    <div className="git-success server-scope-note" role="note">Phase 10 scope: register, verify, and monitor. Remote deployment, image builds, containers, volumes, and proxy management are not available here.</div>

    <section className="git-section"><div className="git-section-header"><div><h2>Registered servers</h2><span>{items.length} configured</span></div><button className="secondary-button" onClick={() => void load()}>Refresh</button></div>
      {items.length ? <div className="server-list">{items.map((server) => <div className="server-row" key={server.id}>
        <div className="server-row-main"><div className="server-row-title"><span className={`server-status server-status-${server.status}`}>{server.status}</span><Link href={`/servers/${server.id}`}><strong>{server.name}</strong></Link><code>{server.username}@{server.hostname}:{server.port}</code></div>
          <div className="server-row-meta">{server.osName || "Unknown OS"}{server.architecture ? ` · ${server.architecture}` : ""}{server.dockerAvailable ? ` · Docker ${server.dockerVersion || "present"}` : " · Docker unavailable"}</div>
          <div className="server-row-meta">{server.cpuCount ? `${server.cpuCount} CPU` : "CPU unknown"} · {bytes(server.memoryBytes)} RAM · {bytes(server.diskBytes)} disk{server.diskFreeBytes ? ` (${bytes(server.diskFreeBytes)} free)` : ""} · checked {when(server.lastCheckedAt)}</div>
          {server.statusCode && <div className="server-row-error">{server.statusCode}: {server.statusMessage}</div>}
        </div>
        <div className="server-row-actions">
          {!server.hostKeyTrusted && <button className="secondary-button" onClick={() => void act(server, "trust")} disabled={Boolean(busy)}>Trust host key</button>}
          <button className="secondary-button" onClick={() => void act(server, "test")} disabled={Boolean(busy) || !server.hostKeyTrusted}>Test</button>
          <button className="secondary-button" onClick={() => void act(server, "refresh")} disabled={Boolean(busy)}>Refresh</button>
          <button className="secondary-button danger-button" onClick={() => void act(server, "remove")} disabled={Boolean(busy)}>Remove</button>
        </div>
      </div>)}</div> : <div className="deployment-empty"><strong>No servers registered</strong><span>Add a Linux host to verify SSH access and collect system metadata.</span><button className="primary-button" onClick={() => setFormOpen(true)}>Add Server</button></div>}
    </section>

    {formOpen && <div className="modal-backdrop" role="presentation"><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="add-server-title"><div className="panel-header"><h2 id="add-server-title">Add server</h2><button className="icon-button" type="button" onClick={() => setFormOpen(false)} aria-label="Close server form">×</button></div>
      <form className="project-form" onSubmit={addServer}>
        <label>Name<input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Production VPS" /></label>
        <label>Hostname or IPv4<input required value={form.hostname} onChange={(event) => update("hostname", event.target.value)} placeholder="203.0.113.10" /><span className="form-note">Host names and IPv4 only. No URLs, ports, or shell characters.</span></label>
        <label>SSH port<input required type="number" min="1" max="65535" value={form.port} onChange={(event) => update("port", event.target.value)} /></label>
        <label>Username<input required value={form.username} onChange={(event) => update("username", event.target.value)} placeholder="deploy" /><span className="form-note">A non-root user with permission to read /proc and run docker version.</span></label>
        <label>Authentication method<select value="key" disabled><option value="key">SSH private key</option></select></label>
        <label>Private key<textarea required rows={6} value={form.privateKey} onChange={(event) => update("privateKey", event.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} autoComplete="off" /><span className="form-note">Encrypted on the server before storage and cleared from this form after submit. It is never returned by the API.</span></label>
        <div className="form-actions"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={busy === "add"}>{busy === "add" ? "Adding" : "Add Server"}</button></div>
      </form>
    </section></div>}
  </div>;
}
