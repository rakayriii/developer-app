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
  return maskSecrets(line).slice(0, 240);
}

/**
 * Masks long opaque tokens while leaving filesystem paths readable.
 *
 * A blanket mask over the base64 alphabet also swallows path segments, which made a bind failure report
 * `[redacted]-os/caddy` and hid the very path that needed fixing. A token that begins with `/` is a path
 * and is kept; anything else long and opaque is masked, as is any `=`-terminated base64 run.
 */
export function maskSecrets(line: string) {
  return line
    .split(/(\s+)/)
    .map((token) => {
      if (token.startsWith("/")) return token;
      if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(token)) return "[redacted]";
      if (/[A-Za-z0-9+/]{24,}={1,2}$/.test(token)) return "[redacted]";
      return token.replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[redacted]");
    })
    .join("");
}
