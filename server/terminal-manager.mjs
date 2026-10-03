import os from "node:os";
import fs from "node:fs";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawn } from "node-pty";

const maxPerUser = Number(process.env.TERMINAL_MAX_SESSIONS_PER_USER || 4);
const maxTotal = Number(process.env.TERMINAL_MAX_SESSIONS_TOTAL || 20);
const idleTimeout = Number(process.env.TERMINAL_IDLE_TIMEOUT_MS || 1800000);
const sessions = new Map();

export class TerminalError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function log(event, data = {}) {
  console.info(JSON.stringify({ service: "terminal", event, ...data }));
}

function shellPath() {
  const candidates = [process.env.SHELL];
  try {
    const username = os.userInfo().username;
    const passwd = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((line) => line.startsWith(`${username}:`));
    candidates.push(passwd?.split(":")[6]);
  } catch { /* passwd is optional on non-Unix hosts. */ }
  candidates.push("/bin/sh");
  return candidates.find((value) => value && fs.existsSync(value)) || "/bin/sh";
}

function terminalEnvironment() {
  const allowed = ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "USERNAME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]).concat([["TERM", "xterm-256color"], ["COLORTERM", "truecolor"]]));
}

function idValue() {
  return randomBytes(18).toString("base64url");
}

function touch(session) {
  session.lastActivityAt = Date.now();
}

function broadcast(session, message) {
  for (const socket of session.sockets) if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

export function createTerminalSession(owner, dimensions = {}) {
  if (typeof process.getuid === "function" && process.getuid() === 0) throw new TerminalError("server_root", "Terminal sessions are disabled because the server is running as root.", 503);
  const userCount = [...sessions.values()].filter((session) => session.owner === owner).length;
  if (sessions.size >= maxTotal) { log("session_limit_rejected", { scope: "total" }); throw new TerminalError("session_limit", "The terminal server has reached its session limit.", 429); }
  if (userCount >= maxPerUser) { log("session_limit_rejected", { scope: "user" }); throw new TerminalError("session_limit", "You have reached your terminal session limit.", 429); }
  const cols = Math.min(Math.max(Number(dimensions.cols) || 120, 40), 240);
  const rows = Math.min(Math.max(Number(dimensions.rows) || 30, 10), 100);
  const id = idValue();
  const pty = spawn(shellPath(), ["-i"], { name: "xterm-256color", cols, rows, cwd: process.env.TERMINAL_WORKING_DIRECTORY || process.cwd(), env: terminalEnvironment() });
  const session = { id, owner, pty, cols, rows, createdAt: Date.now(), lastActivityAt: Date.now(), sockets: new Set(), outputBuffer: "" };
  sessions.set(id, session);
  pty.onData((data) => { touch(session); session.outputBuffer = `${session.outputBuffer}${data}`.slice(-65536); broadcast(session, { type: "output", data }); });
  pty.onExit(({ exitCode, signal }) => { broadcast(session, { type: "exit", code: exitCode, signal: signal || null }); log("pty_exited", { sessionId: id, code: exitCode }); sessions.delete(id); for (const socket of session.sockets) socket.close(1000, "Terminal exited"); });
  log("session_created", { sessionId: id, owner });
  return session;
}

export function getOwnedSession(id, owner) {
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(id)) throw new TerminalError("invalid_session", "The terminal session ID is invalid.", 400);
  const session = sessions.get(id);
  if (!session || session.owner !== owner) throw new TerminalError("not_found", "Terminal session not found.", 404);
  touch(session);
  return session;
}

export function attachTerminalSession(session, socket) {
  session.sockets.add(socket);
  if (session.outputBuffer) socket.send(JSON.stringify({ type: "output", data: session.outputBuffer }));
  log("websocket_connected", { sessionId: session.id, owner: session.owner });
}

export function detachTerminalSession(session, socket) {
  session.sockets.delete(socket);
  log("websocket_disconnected", { sessionId: session.id, owner: session.owner });
}

export function handleTerminalMessage(session, message) {
  touch(session);
  if (!message || typeof message.type !== "string") throw new TerminalError("invalid_message", "Invalid terminal message.", 400);
  if (message.type === "input") { if (typeof message.data !== "string" || message.data.length > 8192) throw new TerminalError("invalid_input", "Terminal input is invalid.", 400); session.pty.write(message.data); return; }
  if (message.type === "resize") { const cols = Number(message.cols); const rows = Number(message.rows); if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || cols > 300 || rows < 5 || rows > 150) throw new TerminalError("invalid_resize", "Terminal dimensions are invalid.", 400); session.cols = cols; session.rows = rows; session.pty.resize(cols, rows); return; }
  if (message.type === "close") { closeTerminalSession(session); return; }
  throw new TerminalError("invalid_message", "Unsupported terminal message.", 400);
}

export function closeTerminalSession(session) {
  if (!sessions.has(session.id)) return;
  log("session_closed", { sessionId: session.id, owner: session.owner });
  sessions.delete(session.id);
  for (const socket of session.sockets) socket.close(1000, "Terminal closed");
  session.sockets.clear();
  session.pty.kill();
}

setInterval(() => { const now = Date.now(); for (const session of sessions.values()) if (now - session.lastActivityAt > idleTimeout) { broadcast(session, { type: "error", message: "Terminal session expired after inactivity." }); closeTerminalSession(session); } }, 60_000).unref();

export function shutdownTerminals() { for (const session of sessions.values()) closeTerminalSession(session); }
