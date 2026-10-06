// Bounded, scrubbed remote failure text.
//
// A remote command that connects and runs but exits non-zero is a normal outcome, not an SSH failure,
// and its own output is the only useful diagnostic: `docker start` rejecting a container prints the
// reason on stderr. Replacing that with a generic sentence makes every remote failure indistinguishable.
//
// Everything here is bounded and stripped of key or token material, because the result is persisted in a
// deployment log.

/** Drops a whole PEM block before line handling, so no key body line can survive masking. */
export function summarizeRemoteFailure(message: string) {
  const withoutBlocks = message.replace(/-{2,}[A-Z ]*PRIVATE KEY-{2,}[\s\S]*?-{2,}[A-Z ]*PRIVATE KEY-{2,}/g, "[redacted-key]");
  const line = withoutBlocks.split("\n").map((entry) => entry.trim()).filter(Boolean).pop() ?? "";
  if (!line) return "";
  return line.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, "[redacted]").slice(0, 240);
}
