import http from "node:http";
import next from "next";
import { WebSocketServer } from "ws";
import { authenticateTerminalRequest } from "./server/terminal-auth.mjs";
import { TerminalError, attachTerminalSession, closeTerminalSession, createTerminalSession, detachTerminalSession, getOwnedSession, handleTerminalMessage, shutdownTerminals } from "./server/terminal-manager.mjs";

const port = Number(process.env.PORT || 3000);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();
const websocketServer = new WebSocketServer({ noServer: true });

function json(response, status, body) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(body)); }
async function body(request) { let value = ""; for await (const chunk of request) { value += chunk; if (value.length > 4096) throw new TerminalError("invalid_body", "Request body is too large.", 413); } return value ? JSON.parse(value) : {}; }
function errorResponse(response, error) { const value = error instanceof TerminalError ? error : new TerminalError("terminal_error", "Terminal service unavailable.", 500); json(response, value.status, { code: value.code, message: value.message }); }

async function terminalHttp(request, response) {
  const owner = await authenticateTerminalRequest(request);
  if (!owner) return json(response, 401, { code: "not_authenticated", message: "Connect GitHub before opening a terminal." });
  try {
    if (request.method === "POST" && request.url === "/api/terminal/session") { const session = createTerminalSession(owner, await body(request)); return json(response, 201, { sessionId: session.id, serverRoot: typeof process.getuid === "function" && process.getuid() === 0 }); }
    if (request.method === "DELETE" && request.url.startsWith("/api/terminal/session/")) { const session = getOwnedSession(request.url.split("/").pop(), owner); closeTerminalSession(session); return json(response, 200, { ok: true }); }
    return json(response, 404, { code: "not_found", message: "Terminal endpoint not found." });
  } catch (error) { return errorResponse(response, error); }
}

websocketServer.on("connection", (socket, request, owner) => {
  const sessionId = new URL(request.url, "http://localhost").searchParams.get("sessionId");
  try {
    const session = getOwnedSession(sessionId, owner);
    attachTerminalSession(session, socket);
    socket.on("message", (value) => { try { handleTerminalMessage(session, JSON.parse(value.toString())); } catch (error) { socket.send(JSON.stringify({ type: "error", message: error instanceof TerminalError ? error.message : "Terminal message failed." })); } });
    socket.on("close", () => detachTerminalSession(session, socket));
    socket.on("error", () => detachTerminalSession(session, socket));
  } catch (error) { socket.send(JSON.stringify({ type: "error", message: error instanceof TerminalError ? error.message : "Terminal session unavailable." })); socket.close(1008); }
});

await app.prepare();
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
const upgrade = app.getUpgradeHandler();
const server = http.createServer((request, response) => { if (request.url?.startsWith("/api/terminal/")) terminalHttp(request, response).catch((error) => errorResponse(response, error)); else handle(request, response); });
server.on("upgrade", async (request, socket, head) => {
  if (!request.url?.startsWith("/api/terminal?")) return upgrade(request, socket, head);
  const owner = await authenticateTerminalRequest(request);
  if (!owner) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
  websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request, owner));
});
const shutdown = () => { shutdownTerminals(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
server.on("error", (error) => {
  // Without a listener Node turns a bind failure into an unhandled 'error' event, so the operator
  // only sees a raw stack trace instead of which port is taken and by what.
  if (error.code === "EADDRINUSE") {
    console.error(JSON.stringify({ service: "server", event: "port_in_use", port, hint: `Another process is already listening on port ${port}. Stop it, or start this server with a different PORT.` }));
  } else {
    console.error(JSON.stringify({ service: "server", event: "startup_failed", message: error.message }));
  }
  shutdown();
});
server.listen(port, () => console.info(JSON.stringify({ service: "server", event: "listening", port })));
