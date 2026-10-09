# Recovery

This is the operational runbook for getting Developer OS back after a failure, and the rules that
govern what may be done automatically.

It covers the two things most likely to lose time: the encryption key a restored database depends on,
and the fact that a restore is never performed automatically.

## The encryption key

**Read this before you rely on any backup.**

Every encrypted value in the database is sealed with AES-256-GCM using a key derived from
`SESSION_SECRET`:

```
key = SHA-256(SESSION_SECRET)
```

That one variable protects all of it:

| What it protects | Where it is stored |
| --- | --- |
| Remote server private keys | `Server.encryptedCredential` |
| Runtime secret values | `DeploymentEnvironmentVariable.secretValue` |
| GitHub OAuth state | session store |

A restored database whose `SESSION_SECRET` differs from the original decrypts **none** of it. The rows
are present and look intact, but every SSH key is unreadable, every runtime secret resolves to nothing,
and every GitHub session is invalid. This failure is silent and looks like data loss.

### Rules

- `SESSION_SECRET` must be kept **outside the repository**. It is in `.env.local`, which is gitignored,
  and must never be committed, pasted into a ticket, or stored in the same place as the backups.
- Keep at least one copy somewhere the backups are *not*, because a backup stored beside its own key
  protects nothing.
- **Never rotate it as a side effect of a backup or a restore.** Rotating it invalidates every encrypted
  value in the database at once. Treat rotation as its own operation: re-encrypt everything in one
  planned pass, or accept that old backups become unreadable.
- Losing it means the encrypted data is unrecoverable. The backup can restore the rows; it cannot
  restore the values.

### Checking a key without printing anything

`POST /api/backups` with `{"action":"restore_check","id":"<id>"}` restores into a disposable database
and reports:

```json
{ "encryptedValues": { "total": 12, "decryptable": 12 }, "secretKeyMatches": true }
```

The check decrypts each value in memory and records only whether a non-empty plaintext came back. No
value is returned, logged, or written to the manifest. A `secretKeyMatches` of `false` with `total > 0`
means **the key is wrong** — fix `SESSION_SECRET` before attempting any real restore.

The disposable database is dropped either way, so this is safe to run repeatedly.

## Taking a backup

`POST /api/backups` with `{"action":"create"}`, or **Back up now** in the Reliability panel.

- A `pg_dump` in custom format is taken by `docker exec` against the container's local socket, using an
  argument array and no shell. No database password appears in argv, in the environment, or in the
  artifact.
- Written outside the repository at `0600` in a `0700` directory. Default
  `~/.developer-os/backups`; override with `BACKUP_DIR`.
- Excluded from the Docker build context by `.dockerignore` as a second line of defence.
- The sha256 and the size are recorded in a sidecar manifest beside the artifact, so the record survives
  a restore of the database itself.

### Optional artifact encryption

Set `BACKUP_ENCRYPTION_KEY` to a high-entropy secret and pass `{"encrypt":true}`. The artifact is then
sealed with AES-256-GCM under a key derived from that variable.

There is no default key. If the variable is not set, an encryption request is declined and an ordinary
unencrypted dump is produced instead. An encrypted artifact cannot be read without the key — including by
`verify`.

## Restoring

**Restore is never automatic and never touches the live database.** There is no endpoint that can
overwrite production data. The only restore path restores into a throwaway database and drops it again.

### 1. Establish that you have the right key

Run `restore_check` first. If `secretKeyMatches` is `false`, stop. Every later step is pointless until
`SESSION_SECRET` is right.

### 2. Verify the artifact

`{"action":"verify","id":"<id>"}` checks two independent things: the recorded sha256 against the bytes on
disk, and that `pg_restore --list` can read the archive index. A file can pass a checksum and still not be
a usable archive if it was replaced, so both must pass.

### 3. Prove the restore

`{"action":"restore_check","id":"<id>"}` creates a scratch database, loads the dump, checks that every
required table is present, counts the rows, and decrypts the encrypted values with the configured key.
Read the counts against what you expect before trusting the artifact.

### 4. Restore for real

Only once 1–3 have passed, and only by hand:

```sh
# Load into a fresh database first, never over the live one.
docker exec developer-os-postgres createdb -U developer_os developer_os_restored
docker cp <artifact> developer-os-postgres:/tmp/restore.dump
docker exec developer-os-postgres pg_restore -U developer_os -d developer_os_restored --no-owner --no-acl /tmp/restore.dump
docker exec developer-os-postgres rm -f /tmp/restore.dump
```

Then compare and switch:

```sh
docker exec developer-os-postgres psql -U developer_os -d developer_os_restored -tAc \
  'select count(*) from "Deployment"'   # sanity-check against expectations
```

To put it into service, stop the application, point `DATABASE_URL` at the restored database, and start
again.

### Rollback limitations

- **Rolling back a restore means going back to the previous dump, not forward.** Every deployment made
  after the dump you restored is gone. There is no undo.
- `pg_restore` does not roll back: if it fails partway, the scratch database is partially populated.
  Drop it and start again rather than re-running over it.
- Migrations are **not** re-run by a restore. A restored database carries the migration history as it was.
  If the application is a newer version than the dump, apply the newer migrations deliberately.
- **Rollback does not re-run migrations either**, matching local deployment behaviour. A schema change
  introduced after the dump being restored is not undone.

## What reconciliation will and will not do

Reconciliation compares recorded state against Docker and the network and corrects what is unambiguous.
It runs on startup and on a single timer, and on demand from the Reliability panel.

**It will:**

- Correct a status that disagrees with a container that is provably absent, stopped, or running.
- Mark a deployment lost during an interrupted operation as failed so it can be retried.
- Regenerate a reverse proxy configuration that has drifted from the recorded domains.
- Withdraw a hostname whose environment has nothing serving, and keep the domain record.

**It will not:**

- Build, deploy, start, stop, restart, or remove anything.
- Delete a deployment, a log entry, or a domain.
- Touch a container it has no record of, or one holding a port it does not own.
- Conclude that a remote container is gone when the remote host could not be reached. An unreachable host
  leaves the last known state untouched and is reported as `unavailable`.

An observation that could not be made is never treated as a negative finding. A health probe that timed
out does not mark a healthy deployment as broken.

Use **Preview changes** for a dry run: it reports the intended corrections and applies nothing.

## When a deployment leaves a container behind

A start whose outcome was never observed — a timeout, a daemon restart, a dropped connection — can leave a
container holding the generated name. The next attempt reclaims it before creating a new one, and only
when the name matches the pattern generated for that deployment. Ownership is proven by the name, never
by a caller-supplied identifier, so a container Developer OS has no record of is left strictly alone.

## Recovering from a database outage

Database failures are classified rather than collapsed, because the remedies differ:

| Condition | What it means | What to do |
| --- | --- | --- |
| `database_unavailable` | The server could not be reached | Start PostgreSQL; it restarts with `unless-stopped` |
| `database_connection_refused` | Something is listening and refused | Check the address and port in `DATABASE_URL` |
| `database_migrations_pending` | Reachable, schema behind | `npx prisma migrate deploy` |
| `database_schema_incompatible` | Schema present but wrong | Apply pending migrations; do not reset |
| `database_unauthorized` | Reachable, credentials rejected | Check the role and password |

The application recovers on its own once the database is back — there is no restart required, because
nothing is cached across requests. **Never reset the database to recover from a schema problem.**