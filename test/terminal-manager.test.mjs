import assert from "node:assert/strict";
import { test } from "node:test";
import { closeTerminalSession, createTerminalSession, getOwnedSession, handleTerminalMessage } from "../server/terminal-manager.mjs";

const waitFor = async (check, timeout = 3000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for PTY output");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

test("creates an owned PTY and executes a safe command", async () => {
  const session = createTerminalSession("test-user", { cols: 100, rows: 24 });
  try {
    assert.equal(getOwnedSession(session.id, "test-user"), session);
    assert.throws(() => getOwnedSession(session.id, "another-user"), /not found/i);
    handleTerminalMessage(session, { type: "input", data: "printf 'hello\\n'\n" });
    await waitFor(() => session.outputBuffer.includes("hello"));
  } finally {
    closeTerminalSession(session);
  }
});

test("forwards terminal resize to the PTY", () => {
  const session = createTerminalSession("resize-user", { cols: 100, rows: 24 });
  const originalResize = session.pty.resize;
  let dimensions = null;
  session.pty.resize = (cols, rows) => { dimensions = { cols, rows }; return originalResize.call(session.pty, cols, rows); };
  try {
    handleTerminalMessage(session, { type: "resize", cols: 120, rows: 30 });
    assert.deepEqual(dimensions, { cols: 120, rows: 30 });
  } finally {
    closeTerminalSession(session);
  }
});

test("removes a session when it is closed", () => {
  const session = createTerminalSession("cleanup-user");
  closeTerminalSession(session);
  assert.throws(() => getOwnedSession(session.id, "cleanup-user"), /not found/i);
});
