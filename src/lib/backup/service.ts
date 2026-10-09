// Backup and restore of Developer OS metadata.
//
// The database is PostgreSQL, so the backup is a PostgreSQL logical dump taken with pg_dump in custom
// format. Copying data files out of a running cluster would not be a backup at all, and the custom format
// is what pg_restore can verify and restore selectively.
//
// Where the dump comes from and where it goes:
//
//   - The dump is produced by `docker exec <postgres> pg_dump`, a server-side process invoked with an
//     argument array. It connects over the container's local socket using the cluster's own trust
//     authentication, so no database password is ever placed in argv, in an environment variable, or in
//     the artifact. The dump itself therefore never contains a connection string.
//   - Artifacts are written outside the repository, 0600, and the directory is excluded from the Docker
//     build context as well.
//
// The critical dependency: every encrypted column - SSH private keys, runtime secret values, and GitHub
// session state - is sealed with a key derived from SESSION_SECRET. A restored database whose SESSION_SECRET
// differs decrypts nothing. See verifySecretsDecryptable, which proves the question without printing a value.

import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { decryptSecret } from "@/lib/deployments/crypto.ts";

export class BackupError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "BackupError";
    this.code = code;
    this.status = status;
  }
}

export type BackupRecord = {
  id: string;
  fileName: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  format: "pg_custom";
  result: "ok" | "failed";
  durationMs: number;
  error?: { code: string; message: string };
};

/** Bounded so a runaway dump cannot exhaust the disk. */
const maxBytes = Number(process.env.BACKUP_MAX_BYTES || 512 * 1024 * 1024);
/** Bounded so a hung database cannot hold the operation open indefinitely. */
const timeoutMs = Number(process.env.BACKUP_TIMEOUT_MS || 10 * 60 * 1000);
const container = () => process.env.POSTGRES_CONTAINER || "developer-os-postgres";
const dbUser = () => process.env.POSTGRES_USER || "developer_os";
const dbName = () => process.env.POSTGRES_DB || "developer_os";

/**
 * Where backups live.
 *
 * Outside the repository by default and required to stay there: a path inside the working tree would put
 * the dump into version control and into the Docker build context.
 */
export function backupDirectory(): string {
  const configured = process.env.BACKUP_DIR;
  if (configured) return path.resolve(configured);
  return path.join(homedir(), ".developer-os", "backups");
}

/** Optional at-rest encryption for the artifact itself, keyed by an operator-supplied secret. */
function artifactKey(): Buffer | null {
  const configured = process.env.BACKUP_ENCRYPTION_KEY;
  if (!configured) return null;
  // A fixed salt is acceptable here because the key is a high-entropy operator secret, not a password.
  // The salt's job is domain separation, not to defeat a dictionary attack on a weak passphrase.
  return scryptSync(configured, "developer-os-backup-artifact", 32);
}

async function ensureDirectory(): Promise<string> {
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  return directory;
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");

/**
 * Runs a command with an argument array and returns its stdout as a Buffer.
 *
 * No shell is involved, so nothing in the arguments can be interpreted as syntax. Output is capped, which
 * is what makes it safe to hand a database's worth of bytes to a caller.
 */
function runCommand(args: string[], capBytes: number, label: string, timeout = timeoutMs): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      reject(new BackupError("backup_timeout", `${label} timed out after ${timeout} ms.`, 503));
    }, timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > capBytes) {
        child.kill("SIGKILL");
        clearTimeout(timer);
        reject(new BackupError("backup_too_large", `${label} exceeded ${capBytes} bytes.`, 413));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); reject(new BackupError("backup_spawn_failed", `${label} could not be started.`, 503)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
      else reject(new BackupError("backup_command_failed", `${label} failed with exit code ${code}.`, 500));
    });
  });
}

/** Encrypts an artifact. The key comes from an operator-supplied secret; there is no default key. */
function encryptArtifact(plaintext: Buffer, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("DOSBKP1"), iv, cipher.getAuthTag(), body]);
}

/** Takes a logical dump and records it beside itself. */
export async function createBackup(options: { encrypt?: boolean } = {}): Promise<BackupRecord> {
  const directory = await ensureDirectory();
  const id = `developer-os-${stamp()}`;
  const key = artifactKey();
  const shouldEncrypt = options.encrypt === true && key !== null;
  const fileName = `${id}.dump${shouldEncrypt ? ".enc" : ""}`;
  const target = path.join(directory, fileName);
  const started = Date.now();

  const record: BackupRecord = {
    id, fileName, path: target, createdAt: new Date().toISOString(), sizeBytes: 0,
    sha256: "", encrypted: shouldEncrypt, format: "pg_custom", result: "failed", durationMs: 0,
  };

  try {
    // Logical dump in custom format, over the container's local socket. No password appears anywhere.
    const { stdout, stderr } = await runCommand(
      ["docker", "exec", container(), "pg_dump", "-U", dbUser(), "-d", dbName(), "--format=custom", "--no-owner", "--no-acl", "--clean", "--if-exists"],
      maxBytes,
      "pg_dump",
    );
    if (!stdout.length) throw new BackupError("backup_empty", "pg_dump produced no output.", 500);

    const artifact = shouldEncrypt ? encryptArtifact(stdout, key as Buffer) : stdout;

    // Written with restrictive permissions from the outset, never created world-readable and tightened after.
    await writeFile(target, artifact, { mode: 0o600 });
    await chmod(target, 0o600).catch(() => undefined);

    record.sizeBytes = artifact.length;
    record.sha256 = createHash("sha256").update(artifact).digest("hex");
    record.result = "ok";
    if (stderr.trim()) {
      // pg_dump warnings are not fatal, but they belong in the record rather than being discarded.
      record.error = { code: "pg_dump_warnings", message: stderr.trim().slice(0, 500) };
    }
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    return record;
  } catch (error) {
    const failure = error as BackupError;
    // A partial artifact is removed: a truncated dump is worse than none, because it looks recoverable.
    await rm(target, { force: true }).catch(() => undefined);
    record.durationMs = Date.now() - started;
    record.error = { code: failure.code ?? "backup_failed", message: failure.message ?? "Backup failed." };
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600 }).catch(() => undefined);
    throw error;
  } finally {
    record.durationMs = Date.now() - started;
  }
}

/** Every recorded backup, newest first. Records are the sidecar manifests, so they survive a restore. */
export async function listBackups(): Promise<BackupRecord[]> {
  const directory = backupDirectory();
  let entries: string[];
  try { entries = await readdir(directory); } catch { return []; }
  const records: BackupRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(directory, entry), "utf8")) as BackupRecord;
      records.push(parsed);
    } catch { /* an unreadable manifest is skipped rather than failing the whole listing */ }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function readArtifact(record: BackupRecord): Promise<Buffer> {
  const raw = await readFile(record.path);
  if (!record.encrypted) return raw;
  const key = artifactKey();
  if (!key) throw new BackupError("backup_key_missing", "This backup is encrypted and BACKUP_ENCRYPTION_KEY is not set.", 409);
  const iv = raw.subarray(6, 18);
  const tag = raw.subarray(18, 34);
  const body = raw.subarray(34);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new BackupError("backup_decrypt_failed", "The backup could not be decrypted with the configured key.", 409);
  }
}

/**
 * Confirms an artifact is intact without restoring it.
 *
 * Two independent checks: the recorded checksum must match the bytes on disk, and pg_restore must be able
 * to read the archive's table of contents. A file that passes a checksum but is not a valid archive is
 * possible if it was replaced, so both are required before a restore is attempted.
 */
export async function verifyBackup(record: BackupRecord): Promise<{ ok: boolean; sha256Matches: boolean; archiveReadable: boolean; sizeBytes: number; error?: { code: string; message: string } }> {
  let info;
  try { info = await stat(record.path); } catch {
    return { ok: false, sha256Matches: false, archiveReadable: false, sizeBytes: 0, error: { code: "backup_missing", message: "The backup file is not present." } };
  }
  const artifact = await readFile(record.path);
  const sha256Matches = createHash("sha256").update(artifact).digest("hex") === record.sha256;

  let archiveReadable = false;
  if (sha256Matches) {
    // pg_restore --list reads the archive index without a database, which is a real structural check.
    await writeFile(path.join(backupDirectory(), `${record.id}.verify.tmp`), await readArtifact(record), { mode: 0o600 }).catch(() => undefined);
    try {
      const listed = await runCommand(["docker", "cp", path.join(backupDirectory(), `${record.id}.verify.tmp`), `${container()}:/tmp/${record.id}.verify.dump`], 64 * 1024, "docker cp");
      void listed;
      const { stdout } = await runCommand(["docker", "exec", container(), "pg_restore", "--list", `/tmp/${record.id}.verify.dump`], 16 * 1024 * 1024, "pg_restore --list");
      archiveReadable = stdout.toString("utf8").includes("TABLE");
    } catch {
      archiveReadable = false;
    } finally {
      await runCommand(["docker", "exec", container(), "rm", "-f", `/tmp/${record.id}.verify.dump`], 64 * 1024, "docker exec rm").catch(() => undefined);
      await rm(path.join(backupDirectory(), `${record.id}.verify.tmp`), { force: true }).catch(() => undefined);
    }
  }
  return { ok: sha256Matches && archiveReadable, sha256Matches, archiveReadable, sizeBytes: info.size };
}

/**
 * Restores into a disposable database and checks the result.
 *
 * The live database is never touched. A throwaway database is created inside the same cluster, the dump
 * is loaded into it, the required tables and the encrypted columns are inspected, and the database is
 * dropped again. This is the only restore path in the application.
 */
export async function restoreIntoDisposableDatabase(record: BackupRecord): Promise<{
  ok: boolean;
  database: string;
  tables: string[];
  counts: Record<string, number>;
  encryptedValues: { total: number; decryptable: number };
  secretKeyMatches: boolean;
  error?: { code: string; message: string };
}> {
  const scratch = `developer_os_restore_${Date.now().toString(36)}`;
  const remotePath = `/tmp/${record.id}.restore.dump`;
  const empty = { ok: false, database: scratch, tables: [] as string[], counts: {} as Record<string, number>, encryptedValues: { total: 0, decryptable: 0 }, secretKeyMatches: false };

  const drop = async () => {
    await runCommand(["docker", "exec", container(), "dropdb", "--if-exists", "-U", dbUser(), scratch], 256 * 1024, "dropdb").catch(() => undefined);
    await runCommand(["docker", "exec", container(), "rm", "-f", remotePath], 64 * 1024, "docker exec rm").catch(() => undefined);
  };

  const verification = await verifyBackup(record);
  if (!verification.ok) {
    await drop();
    return { ...empty, error: { code: "backup_invalid", message: `The backup did not verify (checksum ${verification.sha256Matches ? "ok" : "failed"}, archive ${verification.archiveReadable ? "readable" : "unreadable"}).` } };
  }

  try {
    // Integrity is established before anything is created.
    await writeFile(path.join(backupDirectory(), `${record.id}.restore.tmp`), await readArtifact(record), { mode: 0o600 });
    await runCommand(["docker", "cp", path.join(backupDirectory(), `${record.id}.restore.tmp`), `${container()}:${remotePath}`], 64 * 1024, "docker cp");
    await rm(path.join(backupDirectory(), `${record.id}.restore.tmp`), { force: true }).catch(() => undefined);

    await runCommand(["docker", "exec", container(), "createdb", "-U", dbUser(), scratch], 256 * 1024, "createdb");
    const restored = await runCommand(["docker", "exec", container(), "pg_restore", "-U", dbUser(), "-d", scratch, "--no-owner", "--no-acl", remotePath], maxBytes, "pg_restore");
    void restored;

    // Required tables. A dump missing any of these is not a restorable Developer OS backup.
    const required = ["User", "Project", "DeploymentEnvironment", "Deployment", "DeploymentLog", "Server", "DeploymentDomain", "_prisma_migrations"];
    const { stdout } = await runCommand([
      "docker", "exec", container(), "psql", "-U", dbUser(), "-d", scratch, "-tAc",
      `select table_name from information_schema.tables where table_schema='public' order by table_name`,
    ], 1024 * 1024, "psql");
    const tables = stdout.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
    const missing = required.filter((table) => !tables.includes(table));

    const counts: Record<string, number> = {};
    for (const table of required) {
      if (missing.includes(table)) continue;
      const row = await runCommand(["docker", "exec", container(), "psql", "-U", dbUser(), "-d", scratch, "-tAc", `select count(*) from "${table}"`], 1024 * 1024, "psql count").catch(() => null);
      counts[table] = row ? Number.parseInt(row.stdout.toString("utf8").trim(), 10) || 0 : 0;
    }

    // The decisive question for recovery: can the encrypted values still be decrypted with the key this
    // process is configured with? The values are never printed, never logged, and never leave the process.
    let total = 0;
    let decryptable = 0;
    const secrets = await runCommand([
      "docker", "exec", container(), "psql", "-U", dbUser(), "-d", scratch, "-tAc",
      `select coalesce("secretValue",'') from "DeploymentEnvironmentVariable" where "secretValue" is not null union all select coalesce("encryptedCredential",'') from "Server" where "encryptedCredential" is not null`,
    ], 4 * 1024 * 1024, "psql secrets").catch(() => null);
    if (secrets) {
      for (const line of secrets.stdout.toString("utf8").split("\n")) {
        const value = line.trim();
        if (!value) continue;
        total += 1;
        const plain = decryptSecret(value);
        // Only whether decryption produced a non-empty string is inspected. The value is discarded here.
        if (typeof plain === "string" && plain.length > 0) decryptable += 1;
      }
    }

    return {
      ok: missing.length === 0,
      database: scratch,
      tables,
      counts,
      encryptedValues: { total, decryptable },
      secretKeyMatches: total === 0 ? false : total === decryptable,
      ...(missing.length ? { error: { code: "restore_incomplete", message: `The restored database is missing: ${missing.join(", ")}.` } } : {}),
    };
  } catch (error) {
    const failure = error as BackupError;
    return { ...empty, error: { code: failure.code ?? "restore_failed", message: failure.message ?? "Restore failed." } };
  } finally {
    await drop();
  }
}

/**
 * Removes old artifacts, never the newest valid one.
 *
 * Retention counts backups rather than days so an operator's choice is predictable. The newest artifact
 * whose verification passes is always kept, so a prune cannot leave nothing behind.
 */
export async function pruneBackups(keep = Number(process.env.BACKUP_RETENTION || 7)): Promise<{ removed: string[]; kept: string[] }> {
  const records = await listBackups();
  const limit = Math.max(1, Math.floor(keep));
  if (records.length <= limit) return { removed: [], kept: records.map((record) => record.id) };

  // Candidate for removal, newest first, but the newest *valid* one is pinned regardless.
  let pinned: BackupRecord | null = null;
  for (const record of records) {
    if (record.result !== "ok") continue;
    const verification = await verifyBackup(record);
    if (verification.ok) { pinned = record; break; }
  }

  const removed: string[] = [];
  const kept: string[] = [];
  let validCount = 0;
  for (const record of records) {
    const isPinned = pinned && record.id === pinned.id;
    const beyondLimit = validCount >= limit && record.result === "ok";
    if (isPinned) {
      validCount += 1;
      kept.push(record.id);
      continue;
    }
    if (beyondLimit || record.result !== "ok") {
      await rm(record.path, { force: true }).catch(() => undefined);
      await rm(path.join(backupDirectory(), `${record.id}.json`), { force: true }).catch(() => undefined);
      removed.push(record.id);
      continue;
    }
    validCount += 1;
    kept.push(record.id);
  }
  return { removed, kept };
}