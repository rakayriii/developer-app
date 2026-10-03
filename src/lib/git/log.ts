import { runGit } from "./runner.ts";
import type { GitCommit } from "./types.ts";
export async function getGitLog(repositoryRoot: string, limit: number): Promise<GitCommit[]> { const result = await runGit(["log", `-${limit}`, "--format=%H%x00%h%x00%s%x00%an%x00%cI%x00%P%x1e"], repositoryRoot); return result.stdout.split("\x1e").filter((record) => record.trim()).map((record) => { const [hash, shortHash, subject, author, timestamp, parents = ""] = record.trim().split("\0"); return { hash, shortHash, subject, author, timestamp, parents: parents.split(" ").filter(Boolean) }; }); }
