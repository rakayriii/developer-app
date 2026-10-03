import { runGit } from "./runner.ts";
import type { GitDiff } from "./types.ts";
export async function getGitDiff(repositoryRoot: string, staged: boolean): Promise<GitDiff> { const limit = 750 * 1024; const result = await runGit(staged ? ["diff", "--cached", "--no-ext-diff", "--unified=3", "--"] : ["diff", "--no-ext-diff", "--unified=3", "--"], repositoryRoot, { maxBuffer: limit + 4096 }); const text = result.stdout; return { staged, text: text.slice(0, limit), truncated: text.length > limit }; }
