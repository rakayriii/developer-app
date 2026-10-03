import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getBranches } from "../src/lib/git/branches.ts";
import { getGitDiff } from "../src/lib/git/diff.ts";
import { getGitLog } from "../src/lib/git/log.ts";
import { createBranch, createCommit, pullRepository, pushRepository, stageFiles, unstageFiles } from "../src/lib/git/operations.ts";
import { getRemoteMetadata } from "../src/lib/git/remote.ts";
import { getGitStatus } from "../src/lib/git/status.ts";
import { withGitMutation } from "../src/lib/git/lock.ts";
import { GitValidationError, resolveRepository } from "../src/lib/git/validation.ts";

const exec = promisify(nodeExecFile);
async function git(cwd, ...args) { await exec("git", args, { cwd }); }
async function repository() { const root = await mkdtemp(path.join(os.tmpdir(), "developer-os-git-")); const repo = path.join(root, "repo"); await mkdir(repo); await git(repo, "init", "--initial-branch=main"); await git(repo, "config", "user.name", "Test User"); await git(repo, "config", "user.email", "test@example.com"); await writeFile(path.join(repo, "README.md"), "initial\n"); await git(repo, "add", "README.md"); await git(repo, "commit", "-m", "initial commit"); process.env.GIT_WORKSPACE_ROOT = root; return { root, repo }; }

test("reads real status, creates branches, stages, commits, and logs", async () => {
  const { repo } = await repository();
  await writeFile(path.join(repo, "README.md"), "changed\n"); await writeFile(path.join(repo, "new.txt"), "new\n");
  const dirty = await getGitStatus(repo); assert.equal(dirty.branch, "main"); assert.equal(dirty.untrackedFiles[0].path, "new.txt"); assert.ok(dirty.unstagedFiles.some((file) => file.path === "README.md"));
  await stageFiles(repo, ["README.md", "new.txt"]); assert.equal((await getGitStatus(repo)).stagedFiles.length, 2); assert.match((await getGitDiff(repo, true)).text, /changed/);
  await unstageFiles(repo, ["new.txt"]); assert.equal((await getGitStatus(repo)).stagedFiles.length, 1);
  await stageFiles(repo, ["new.txt"]); const commit = await createCommit(repo, "update files"); assert.equal(commit.subject, "update files"); assert.equal((await getGitLog(repo, 2)).length, 2);
  await createBranch(repo, "feature/test"); assert.ok((await getBranches(repo)).some((branch) => branch.name === "feature/test"));
  await assert.rejects(() => createBranch(repo, "../unsafe"), /invalid/i);
  await assert.rejects(() => pullRepository(repo), /upstream/i);
  await assert.rejects(() => pushRepository(repo), /upstream/i);
});

test("rejects paths outside the workspace and invalid repository roots", async () => {
  const { root, repo } = await repository();
  await assert.rejects(() => resolveRepository("../"), (error) => error instanceof GitValidationError && error.status === 403);
  await assert.rejects(() => resolveRepository("missing"), (error) => error instanceof GitValidationError && error.status === 404);
  await assert.rejects(() => stageFiles(repo, ["../outside"]), (error) => error instanceof GitValidationError && error.status === 400);
  assert.equal((await resolveRepository("repo")).repositoryRoot, repo);
  void root;
});

test("redacts credentials from remote metadata and serializes mutations", async () => {
  const { repo } = await repository(); await git(repo, "remote", "add", "origin", "https://user:secret@example.com/acme/project.git"); const remotes = await getRemoteMetadata(repo); assert.deepEqual(remotes[0], { name: "origin", host: "example.com", repository: "acme/project" });
  const order = []; const first = withGitMutation(repo, async () => { order.push("first-start"); await new Promise((resolve) => setTimeout(resolve, 20)); order.push("first-end"); }); const second = withGitMutation(repo, async () => { order.push("second"); }); await Promise.all([first, second]); assert.deepEqual(order, ["first-start", "first-end", "second"]);
});
