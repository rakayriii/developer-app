export const knownLogStages = ["validation", "build", "transfer", "remote_image", "container", "system", "release", "health", "runtime", "stop", "restart", "rollback", "diagnostics", "error"] as const;
// Lifecycle display order. These are the stage names actually persisted in DeploymentLog.stream
// (see stageStream in stages.ts), not the internal Stage enum members. "transfer" and "remote_image"
// only ever appear for a remote deployment, and stay empty for a local one.
export const stageOrder = ["validation", "build", "transfer", "remote_image", "port", "container", "release", "health", "runtime", "stop", "restart", "rollback"] as const;

const knownStageSet = new Set<string>(knownLogStages);

export type DeploymentLogEntry = { id: string; timestamp: string; stage: string; stream: string; severity: "info" | "error"; message: string };

// The API returns { entries, count }. Historically it returned a bare array, so both shapes are
// normalized here. Without this, an object response silently yields an empty list in the UI.
export function normalizeLogResponse(body: unknown): DeploymentLogEntry[] {
  const rows = Array.isArray(body) ? body : Array.isArray((body as { entries?: unknown } | null)?.entries) ? (body as { entries: unknown[] }).entries : [];
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => {
      const stream = typeof row.stream === "string" ? row.stream : typeof row.stage === "string" ? row.stage : "runtime";
      return {
        id: String(row.id ?? ""),
        timestamp: String(row.timestamp ?? ""),
        stream,
        stage: typeof row.stage === "string" ? row.stage : knownStageSet.has(stream) ? stream : "runtime",
        severity: (row.severity === "error" || stream === "error") ? "error" : "info",
        message: typeof row.message === "string" ? row.message : "",
      };
    });
}

export function groupLogsByStage(entries: readonly DeploymentLogEntry[]) {
  const ordered = stageOrder.map((stage) => ({ stage, entries: entries.filter((entry) => entry.stage === stage) })).filter((group) => group.entries.length);
  const known = new Set<string>(stageOrder);
  const other = entries.filter((entry) => !known.has(entry.stage));
  return { ordered, other };
}
