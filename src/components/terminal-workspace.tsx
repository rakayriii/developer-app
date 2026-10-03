"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalState = "idle" | "creating" | "connected" | "lost" | "exited" | "error";

export default function TerminalWorkspace() {
  const terminalElement = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const sessionId = useRef("");
  const [state, setState] = useState<TerminalState>("idle");
  const [message, setMessage] = useState("");
  const [serverRoot, setServerRoot] = useState(false);
  const [sessionLabel, setSessionLabel] = useState("");
  const closedByUser = useRef(false);
  const terminalExited = useRef(false);

  useEffect(() => {
    if (!terminalElement.current) return;
    const tokens = getComputedStyle(document.querySelector(".app-shell") || document.documentElement);
    const token = (name: string, fallback: string) => tokens.getPropertyValue(name).trim() || fallback;
    const instance = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: "var(--font-geist-mono), monospace", fontSize: 13, theme: { background: token("--bg", "#0b0d0f"), foreground: token("--text", "#f2f4f7"), cursor: token("--blue", "#8ab4ff"), selectionBackground: token("--blue-bg", "#1a2940") }, scrollback: 5000 });
    const addon = new FitAddon();
    instance.loadAddon(addon);
    instance.open(terminalElement.current);
    terminal.current = instance;
    fit.current = addon;
    const resize = () => { addon.fit(); const currentSocket = socket.current; if (currentSocket?.readyState === WebSocket.OPEN) currentSocket.send(JSON.stringify({ type: "resize", cols: instance.cols, rows: instance.rows })); };
    const observer = new ResizeObserver(resize);
    observer.observe(terminalElement.current);
    instance.onData((data) => { if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "input", data })); });
    return () => { observer.disconnect(); socket.current?.close(); instance.dispose(); terminal.current = null; };
  }, []);

  const connect = async () => {
    closedByUser.current = false;
    terminalExited.current = false;
    setState("creating"); setMessage("");
    try {
      const instance = terminal.current;
      const response = await fetch("/api/terminal/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols: instance?.cols || 120, rows: instance?.rows || 30 }) });
      const body = await response.json();
      if (!response.ok) throw body;
      sessionId.current = body.sessionId;
      setSessionLabel(body.sessionId.slice(0, 8));
      setServerRoot(Boolean(body.serverRoot));
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const currentSocket = new WebSocket(`${protocol}//${window.location.host}/api/terminal?sessionId=${encodeURIComponent(body.sessionId)}`);
      socket.current = currentSocket;
      currentSocket.onopen = () => { setState("connected"); terminal.current?.writeln("\x1b[90mConnected to Developer OS terminal.\x1b[0m"); fit.current?.fit(); if (terminal.current) currentSocket.send(JSON.stringify({ type: "resize", cols: terminal.current.cols, rows: terminal.current.rows })); terminal.current?.focus(); };
      currentSocket.onmessage = (event) => { const messageBody = JSON.parse(event.data) as { type: string; data?: string; code?: number; message?: string }; if (messageBody.type === "output") terminal.current?.write(messageBody.data || ""); if (messageBody.type === "error") { setMessage(messageBody.message || "Terminal error."); setState("error"); } if (messageBody.type === "exit") { terminalExited.current = true; setMessage(`Terminal exited with code ${messageBody.code ?? 0}.`); setState("exited"); } };
      currentSocket.onerror = () => { setMessage("WebSocket connection failed."); setState("error"); };
      currentSocket.onclose = () => { if (!closedByUser.current && !terminalExited.current) { setMessage("Terminal connection lost."); setState("lost"); } socket.current = null; };
    } catch (reason) { const value = reason as { message?: string }; setMessage(value.message || "Terminal session could not be created."); setState("error"); }
  };
  const close = () => { closedByUser.current = true; socket.current?.send(JSON.stringify({ type: "close" })); socket.current?.close(); socket.current = null; sessionId.current = ""; setSessionLabel(""); setState("idle"); setMessage(""); };
  const clear = () => terminal.current?.clear();
  const active = state === "creating" || state === "connected";
  return <div className="terminal-workspace"><div className="terminal-header"><div><h1>Terminal</h1><p>Commands run with the permissions of the Developer OS server process.</p></div><div className="terminal-actions"><button className="secondary-button" onClick={connect} disabled={active}>{state === "lost" || state === "exited" ? "Reconnect" : "New session"}</button><button className="secondary-button" onClick={clear} disabled={state === "idle"}>Clear</button><button className="secondary-button" onClick={close} disabled={!active}>Close</button></div></div>{serverRoot && <div className="github-state github-error" role="alert"><strong>Terminal disabled for root safety</strong><span>The server process is running as root. Run Developer OS as an unprivileged user before opening a terminal.</span></div>}<div className="terminal-frame"><div className="terminal-canvas" ref={terminalElement} /></div><div className="terminal-status"><span className={`status status-${state === "connected" ? "green" : state === "error" || state === "lost" ? "yellow" : "blue"}`}><span className="status-dot" />{state === "idle" ? "Not connected" : state.charAt(0).toUpperCase() + state.slice(1)}</span><span>{sessionLabel ? `Session: ${sessionLabel}` : message || "No active session"}</span></div>{message && state !== "connected" && <div className="terminal-error" role="alert">{message}</div>}</div>;
}
