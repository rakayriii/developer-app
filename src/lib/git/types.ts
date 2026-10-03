export type GitFileStatus = { path: string; status: string; stagedState: string; workingTreeState: string; originalPath?: string };
export type GitStatus = { repositoryRoot: string; branch: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; stagedFiles: GitFileStatus[]; unstagedFiles: GitFileStatus[]; untrackedFiles: GitFileStatus[]; conflictedFiles: GitFileStatus[]; remotes: GitRemote[]; clean: boolean };
export type GitBranch = { name: string; current: boolean; upstream: string | null; remote: boolean; ahead: number | null; behind: number | null };
export type GitRemote = { name: string; host: string; repository: string };
export type GitCommit = { hash: string; shortHash: string; subject: string; author: string; timestamp: string; parents: string[] };
export type GitDiff = { staged: boolean; text: string; truncated: boolean };
