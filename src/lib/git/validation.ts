import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./runner.ts";

export class GitValidationError extends Error { code: string; status: number; constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; } }
function workspaceRoot() { const value = process.env.GIT_WORKSPACE_ROOT; if (!value) throw new GitValidationError("workspace_not_configured", "GIT_WORKSPACE_ROOT is not configured.", 503); return path.resolve(value); }
function contained(root: string, candidate: string) { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }

export async function resolveRepository(repository = ".") {
  if (typeof repository !== "string" || !repository || repository.includes("\0") || path.isAbsolute(repository)) throw new GitValidationError("invalid_repository", "Repository must be a relative path inside the configured workspace.");
  const root = await realpath(workspaceRoot()).catch(() => { throw new GitValidationError("workspace_not_found", "The configured Git workspace does not exist.", 404); });
  const candidate = path.resolve(root, repository);
  if (!contained(root, candidate) || repository.split(/[\\/]/).includes("..")) throw new GitValidationError("repository_forbidden", "Repository is outside the configured Git workspace.", 403);
  const canonical = await realpath(candidate).catch(() => { throw new GitValidationError("repository_not_found", "Repository was not found.", 404); });
  if (!contained(root, canonical)) throw new GitValidationError("repository_forbidden", "Repository is outside the configured Git workspace.", 403);
  const information = await stat(canonical).catch(() => null);
  if (!information?.isDirectory()) throw new GitValidationError("invalid_repository", "Repository path is not a directory.");
  try { const result = await runGit(["rev-parse", "--show-toplevel"], canonical); const gitRoot = await realpath(result.stdout.trim()); if (gitRoot !== canonical) throw new GitValidationError("invalid_repository", "The selected path is not the repository root."); } catch (error) { if (error instanceof GitValidationError) throw error; throw new GitValidationError("invalid_repository", "The selected path is not a valid Git repository."); }
  return { root, repositoryRoot: canonical };
}

export async function validateRepositoryPath(repositoryRoot: string, value: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new GitValidationError("invalid_path", "File paths must stay inside the repository.");
  const candidate = path.resolve(repositoryRoot, value);
  if (!contained(repositoryRoot, candidate)) throw new GitValidationError("invalid_path", "File path is outside the repository.");
  const existing = await lstat(candidate).catch(() => null);
  if (existing) { const canonical = await realpath(candidate); if (!contained(repositoryRoot, canonical)) throw new GitValidationError("invalid_path", "Symlinked file path is outside the repository."); }
  else { const parent = await realpath(path.dirname(candidate)).catch(() => null); if (!parent || !contained(repositoryRoot, parent)) throw new GitValidationError("invalid_path", "File path is outside the repository."); }
  return value;
}

export function validateBranchName(name: string) { if (typeof name !== "string" || !name || name.length > 255 || name.startsWith("-") || name.includes("..") || name.includes("\\") || name.includes("@{") || name.startsWith("/") || name.endsWith("/") || name.includes("//") || /[\x00-\x20~^:?*\[\]]/.test(name)) throw new GitValidationError("invalid_branch", "Branch name is invalid."); return name; }
