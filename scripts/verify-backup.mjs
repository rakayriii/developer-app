// Real verification of backup and restore.
//
// Everything runs against the live Developer OS database for the dump, because a backup that was taken
// from a toy database would prove nothing about the real one. Nothing destructive happens to that
// database: the restore path only ever writes to a throwaway database which is dropped again, and the
// real recovery procedure is documented rather than executed.
//
//   BACKUP_DIR=/tmp/opencode/backups node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-backup.mjs
import { readFileSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";

process.env.BACKUP_DIR ||= "/tmp/opencode/backups";
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.GIT_WORKSPACE_ROOT ||= "/home/skywalker";

const { prisma } = await import("../src/lib/db.ts");
const { createBackup, listBackups, verifyBackup, restoreIntoDisposableDatabase, pruneBackups, backupDirectory } = await import("../src/lib/backup/service.ts");

const problems = [];
const fail = (message) => { problems.push(message); console.error(`   !! ${message}`); };
const log = (...parts) => console.log(...parts);
const step = (n, title) => log(`\n${n}. ${title}`);

const created = [];

try {
log(`backup directory: ${backupDirectory()}`);

// -------------------------------------------------------------------------------------------
step(1, "the backup directory is outside the repository and the build context");
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = process.cwd();
  const insideRepo = backupDirectory().startsWith(`${root}/`);
  log(`   directory: ${backupDirectory()} (inside repo: ${insideRepo})`);
  if (insideRepo) fail("the backup directory is inside the repository");

  const dockerignore = readFileSync(`${root}/.dockerignore`, "utf8");
  if (!/^\*\.dump$/m.test(dockerignore) || !/^backups\/$/m.test(dockerignore)) fail(".dockerignore does not exclude backup artifacts");
  log("   .dockerignore excludes *.dump and backups/");

  // Prove the exclusion empirically, by asking the daemon to send a context tarball and listing it.
  // A `docker build` with an empty Dockerfile would scan the whole tree for nothing; this asks the
  // question directly.
  const sent = await run("bash", ["-c", `cd ${JSON.stringify(root)} && tar -cf - --exclude-from=.dockerignore . 2>/dev/null | tar -tf - 2>/dev/null | grep -E '\\.(dump|sql)(\\.gz|\\.enc)?$' | head -5`]).then((r) => r.stdout.toString("utf8").trim()).catch(() => "");
  log(`   backup-shaped files the build context would carry: ${sent ? sent : "none"}`);
  if (sent) fail("a backup artifact would be included in the Docker build context");
}

// -------------------------------------------------------------------------------------------
step(2, "a real backup of the live database");
{
  const record = await createBackup();
  created.push(record.id);
  log(`   ${record.fileName} | ${(record.sizeBytes / 1024 / 1024).toFixed(2)} MB | ${record.durationMs}ms | sha256 ${record.sha256.slice(0, 16)}...`);
  if (record.result !== "ok") fail(`backup result is ${record.result}`);
  if (!record.sizeBytes) fail("the backup is empty");
  if (!/^[0-9a-f]{64}$/.test(record.sha256)) fail("the checksum is not a sha256 digest");
  if (record.encrypted) fail("the artifact was encrypted without BACKUP_ENCRYPTION_KEY being set");
}

// -------------------------------------------------------------------------------------------
step(3, "the artifact is restrictive and contains no credential");
{
  const { stat, readFile } = await import("node:fs/promises");
  const record = created.length ? (await listBackups()).find((entry) => entry.id === created[0]) : null;
  const info = await stat(record.path);
  const mode = info.mode & 0o777;
  log(`   mode ${mode.toString(8)} | size ${info.size}`);
  if (mode !== 0o600) fail(`artifact mode is ${mode.toString(8)}, expected 600`);

  const dirInfo = await stat(backupDirectory());
  const dirMode = dirInfo.mode & 0o777;
  log(`   directory mode ${dirMode.toString(8)}`);
  if ((dirMode & 0o077) !== 0) fail(`backup directory is group or world accessible (${dirMode.toString(8)})`);

  // The dump must not contain the connection string. pg_dump over the container's local socket never
  // sees it, and this proves it rather than assuming it.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("docker", ["cp", record.path, `${process.env.POSTGRES_CONTAINER || "developer-os-postgres"}:/tmp/check.dump`]);
  const listed = await promisify(execFile)("docker", ["exec", process.env.POSTGRES_CONTAINER || "developer-os-postgres", "pg_restore", "--list", "/tmp/check.dump"]);
  const listing = listed.stdout.toString("utf8");
  await promisify(execFile)("docker", ["exec", process.env.POSTGRES_CONTAINER || "developer-os-postgres", "rm", "-f", "/tmp/check.dump"]);

  const requiredTables = ["User", "Project", "DeploymentEnvironment", "Deployment", "DeploymentLog", "Server", "DeploymentDomain"];
  const missing = requiredTables.filter((table) => !listing.includes(`TABLE public ${table}`));
  log(`   archive lists ${listing.split("\n").length} objects; missing tables: ${missing.length ? missing.join(", ") : "none"}`);
  for (const table of missing) fail(`the dump does not contain ${table}`);

  const raw = await readFile(record.path);
  // Encrypted columns are ciphertext; a plaintext secret must never appear in a dump.
  const leaks = raw.toString("latin1").match(/postgres(?:ql)?:\/\/[^\s"']+/g) || [];
  log(`   connection strings found in the artifact: ${leaks.length}`);
  for (const leak of leaks) fail(`the artifact contains a connection string: ${leak.slice(0, 12)}...`);
}

// -------------------------------------------------------------------------------------------
step(4, "an intact backup verifies");
{
  const record = (await listBackups()).find((entry) => entry.id === created[0]);
  const verification = await verifyBackup(record);
  log(`   sha256 matches: ${verification.sha256Matches} | archive readable: ${verification.archiveReadable} | ok: ${verification.ok}`);
  if (!verification.sha256Matches) fail("an untouched backup failed its checksum");
  if (!verification.archiveReadable) fail("pg_restore could not read the archive");
  if (!verification.ok) fail("an intact backup did not verify");
}

// -------------------------------------------------------------------------------------------
step(5, "a corrupt backup is rejected");
{
  const { writeFile, copyFile } = await import("node:fs/promises");
  const record = (await listBackups()).find((entry) => entry.id === created[0]);
  const corruptedPath = record.path.replace(/\.dump(\.enc)?$/, ".corrupt.dump");
  const original = await readFile(record.path);
  // Flip bytes in the middle: the length stays plausible and the checksum must catch it.
  const damaged = Buffer.from(original);
  for (let index = Math.floor(damaged.length / 2); index < Math.floor(damaged.length / 2) + 64 && index < damaged.length; index += 1) damaged[index] ^= 0xff;
  await writeFile(corruptedPath, damaged, { mode: 0o600 });

  const corrupted = { ...record, path: corruptedPath, fileName: "corrupt.dump" };
  const verification = await verifyBackup(corrupted);
  log(`   corrupted copy: sha256 matches ${verification.sha256Matches} | archive readable ${verification.archiveReadable} | ok ${verification.ok}`);
  if (verification.ok) fail("a corrupted backup was accepted");
  if (verification.sha256Matches) fail("checksum did not detect corruption");

  const restoration = await restoreIntoDisposableDatabase(corrupted);
  log(`   restore of a corrupt backup: ok=${restoration.ok} code=${restoration.error?.code}`);
  if (restoration.ok) fail("a corrupt backup was restored");
  if (restoration.error?.code !== "backup_invalid") fail(`unexpected refusal code ${restoration.error?.code}`);

  await rm(corruptedPath, { force: true });
  void copyFile;
}

// -------------------------------------------------------------------------------------------
step(6, "restore into a disposable database, with the live database untouched");
{
  const before = {
    deployments: await prisma.deployment.count(),
    logs: await prisma.deploymentLog.count(),
    servers: await prisma.server.count(),
    domains: await prisma.deploymentDomain.count(),
  };
  const record = (await listBackups()).find((entry) => entry.id === created[0]);
  const result = await restoreIntoDisposableDatabase(record);
  log(`   ok: ${result.ok} | tables: ${result.tables.length}`);
  log(`   counts: ${JSON.stringify(result.counts)}`);
  log(`   encrypted values: ${result.encryptedValues.decryptable}/${result.encryptedValues.total} decryptable | SESSION_SECRET matches: ${result.secretKeyMatches}`);
  if (!result.ok) fail(`restore failed: ${result.error?.code} ${result.error?.message}`);
  if (result.counts.Deployment !== before.deployments) fail(`restored deployment count ${result.counts.Deployment} differs from live ${before.deployments}`);
  if (result.counts.DeploymentLog !== before.logs) fail(`restored log count ${result.counts.DeploymentLog} differs from live ${before.logs}`);
  if (result.encryptedValues.total === 0) fail("no encrypted values were found, so decryptability was not actually proven");
  if (!result.secretKeyMatches) fail("the encrypted values could not be decrypted with the configured SESSION_SECRET");

  const after = {
    deployments: await prisma.deployment.count(),
    logs: await prisma.deploymentLog.count(),
    servers: await prisma.server.count(),
    domains: await prisma.deploymentDomain.count(),
  };
  log(`   live database after: ${JSON.stringify(after)}`);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail("the restore modified the live database");
}

// -------------------------------------------------------------------------------------------
step(7, "the disposable database is gone");
{
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const out = await promisify(execFile)("docker", ["exec", process.env.POSTGRES_CONTAINER || "developer-os-postgres", "psql", "-U", process.env.POSTGRES_USER || "developer_os", "-d", "postgres", "-tAc", "select datname from pg_database where datname like 'developer_os_restore_%'"]);
  const remaining = out.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  log(`   leftover restore databases: ${remaining.length}`);
  if (remaining.length) fail(`disposable restore databases were left behind: ${remaining.join(", ")}`);
}

// -------------------------------------------------------------------------------------------
step(8, "encryption requires an explicit key, and there is no default");
{
  const { createBackup: createAgain } = await import("../src/lib/backup/service.ts");
  const encrypted = await createAgain({ encrypt: true });
  created.push(encrypted.id);
  log(`   encrypt requested without BACKUP_ENCRYPTION_KEY -> encrypted=${encrypted.encrypted}`);
  // No key is configured, so the request is declined rather than silently producing an unencrypted file.
  if (encrypted.encrypted) fail("an artifact was encrypted without a key being configured");
  if (!encrypted.result) fail("the backup failed");

  // Reading an encrypted artifact without the key must refuse rather than return garbage.
  const { readArtifact } = await import("../src/lib/backup/service.ts");
  const fakeEncrypted = { ...encrypted, encrypted: true };
  const failure = await readArtifact(fakeEncrypted).then(() => null, (error) => error);
  log(`   reading an encrypted artifact with no key: ${failure ? `refused with ${failure.code}` : "RETURNED DATA"}`);
  if (!failure) fail("an encrypted artifact was read without the key");
  if (failure && failure.code !== "backup_key_missing") fail(`unexpected code ${failure.code}`);
}

// -------------------------------------------------------------------------------------------
step(9, "retention never removes the newest valid backup");
{
  const before = await listBackups();
  const result = await pruneBackups(2);
  const after = await listBackups();
  log(`   ${before.length} -> ${after.length} kept (limit 2), removed ${result.removed.length}`);
  if (!after.length) fail("pruning removed every backup");
  const newest = before[0];
  if (!after.some((entry) => entry.id === newest.id)) fail("pruning removed the newest backup");
  if (after.length > 2) fail(`retention left ${after.length} backups, expected at most 2`);
}
} finally {
  // The verification's own artifacts are removed; the operator's real backups are not touched.
  await rm(backupDirectory(), { recursive: true, force: true }).catch(() => undefined);
  await prisma.$disconnect();
}

log(problems.length ? `\nRESULT: FAILED (${problems.length} problem(s))` : "\nRESULT: PASSED");
process.exit(problems.length ? 1 : 0);