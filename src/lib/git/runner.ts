import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export class GitError extends Error { code: string; status: number; output: string; constructor(code: string, message: string, status = 500, output = "") { super(message); this.code = code; this.status = status; this.output = output; } }

export async function runGit(args: string[], cwd: string, options: { maxBuffer?: number } = {}) {
  try {
    const result = await execute("git", args, { cwd, shell: false, timeout: 15000, maxBuffer: options.maxBuffer || 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };
    const output = `${value.stdout || ""}${value.stderr || ""}`.trim();
    if (value.code === "ENOENT") throw new GitError("git_unavailable", "Git is not available on the server.", 503, output);
    if (value.killed || value.code === "ETIMEDOUT") throw new GitError("git_timeout", "Git did not finish in time.", 504, output);
    throw new GitError("git_failed", normalizeGitError(output), 409, output);
  }
}

export function normalizeGitError(output: string) {
  const lower = output.toLowerCase();
  if (lower.includes("nothing to commit")) return "Nothing to commit.";
  if (lower.includes("no upstream branch") || lower.includes("no configured push destination")) return "No upstream branch is configured.";
  if (lower.includes("would be overwritten") || lower.includes("local changes")) return "The working tree has conflicting uncommitted changes.";
  if (lower.includes("conflict") || lower.includes("unmerged")) return "Git reported merge conflicts.";
  if (lower.includes("detached head")) return "The repository is in detached HEAD state.";
  if (lower.includes("rejected")) return "The remote rejected the operation.";
  return output.split("\n").filter(Boolean).slice(-1)[0] || "Git operation failed.";
}
