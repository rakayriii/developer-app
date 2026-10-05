This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Terminal architecture

The Terminal workspace uses `xterm.js` in the browser, a WebSocket upgrade handled by `server.mjs`, and `node-pty` on the server. Terminal sessions are ephemeral and kept in memory only. The PTY inherits the Developer OS server process permissions and does not run inside a Docker container.

The server requires an unprivileged process. If the server runs as root, terminal session creation is refused. Do not expose the WebSocket server or Docker socket directly to the public internet.

Terminal limits are configured with `TERMINAL_MAX_SESSIONS_PER_USER`, `TERMINAL_MAX_SESSIONS_TOTAL`, `TERMINAL_IDLE_TIMEOUT_MS`, and the optional `TERMINAL_WORKING_DIRECTORY` environment variables. The existing GitHub HTTP-only session cookie authenticates session creation and WebSocket attachment. Session IDs are owner-checked server-side. Terminal input, output, tokens, and environment secrets are not logged.

The custom Node server is required for WebSocket upgrades:

```bash
npm run dev
npm run build
npm start
```

## System Monitoring

The System workspace reads Linux host metrics server-side. It uses `/proc`, `/sys`, safe filesystem statistics, and `os` APIs for CPU, memory, disks, temperatures, network counters, uptime, and processes. The browser receives structured metric responses and never reads the host directly.

Monitoring requires the authenticated GitHub session and is read-only. The overview endpoint polls every two seconds; process data polls every four seconds. CPU and memory charts retain a bounded 60-sample history in the browser. Process rows contain names, resource usage, status, and user, but not command lines or environment variables.

Available routes are `/api/system/overview`, `/api/system/cpu`, `/api/system/memory`, `/api/system/disk`, `/api/system/gpu`, `/api/system/temperature`, `/api/system/network`, and `/api/system/processes`. Process sorting accepts `cpu`, `memory`, `pid`, or `name`, with a maximum page size of 100.

NVIDIA metrics are collected through `nvidia-smi` when it is installed and accessible. GPU support is optional. AMD and Intel GPU providers are not implemented yet. Missing thermal sensors, GPU support, or individual metric sources produce an unavailable or partial result rather than fabricated values. The monitoring APIs do not accept filesystem paths, shell commands, or process-control operations.

## Git workspace

The Git workspace operates on real local repositories through a server-only Git service. Set `GIT_WORKSPACE_ROOT` to the parent directory that may contain repositories, for example `/home/skywalker`. Browser requests provide only a relative repository path. The server canonicalizes it, rejects traversal and symlink escapes, confirms it is a Git repository, and never accepts arbitrary Git commands or remote destinations.

Supported read operations include status, branches, history, diffs, and redacted remote metadata. Supported mutations are branch creation, clean-working-tree checkout, stage, unstage, commit, normal pull, and push to the configured upstream. Mutations use fixed Git argument arrays and are serialized per repository. Force push, force checkout, reset, clean, remote changes, process control, and deployment are not implemented.

Git routes require the existing authenticated GitHub session. Git state is derived from the repository and is not persisted in PostgreSQL. Git pull and checkout refuse dirty or conflicted working trees so local changes are not silently discarded. Diff responses are bounded and report truncation.

## Deployment and environments

Phase 8 provides local Docker deployments only. Projects may reference a validated local Git repository under `GIT_WORKSPACE_ROOT`. Each project can have development, staging, and production environments with server-validated ports, health paths, CPU limits, memory limits, and restart policy.

Environments can carry runtime environment variables for application configuration. Names come from a fixed server-side allowlist (`APP_KEY`, `APP_ENV`, `APP_DEBUG`, `APP_URL`, `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `SESSION_DRIVER`, `CACHE_STORE`, `QUEUE_CONNECTION`); `PORT` stays engine-controlled. `APP_KEY` and `DB_PASSWORD` are stored encrypted with AES-256-GCM, are write-only in the UI, are never returned by GET APIs, and are redacted from deployment logs. Values are injected with `docker run --env` at container start and are never baked into an image. When an application needs its schema created, enable migrations on the environment: the engine runs the fixed server-side command `php artisan migrate --force` inside the started container. Failed deployments record the failing stage (build, port, container startup, release command, or health check), the health-check URL and HTTP status, a bounded response excerpt, the container state, and a container log tail before the container is removed.

Deployment operations are exposed per deployment. Every status write is validated against an explicit lifecycle graph (`pending -> building -> starting -> running`, with `unhealthy`, `stopping`, `stopped`, `failed`, and `rolled_back` as terminal or transitional states); an illegal transition returns `409 invalid_deployment_transition`. Stop and restart act only on the deployment's own container, whose name is always recomputed server-side from project slug, environment slug, and deployment id, and re-verified against the running host before any Docker call. Restart re-runs the health check and records the outcome. Redeploy creates a new deployment record from the current environment configuration and never mutates the source record. Rollback deploys the exact known-good image of a selected previous deployment and never rebuilds from current source; the candidate is re-validated as belonging to the same environment and as still existing locally. Because a host port can only be bound once, an incumbent Developer OS container is stopped (with diagnostics captured first) before a replacement starts. `/deployments/[id]` shows overview, runtime, staged logs, history, and environment detail, plus a server-generated Open App URL available only while a deployment is running or unhealthy.


Deployment builds the repository's existing supported Dockerfile with a server-generated immutable image tag, starts a bounded container, and checks its configured HTTP endpoint before activating it. Docker operations default to a bounded 10-minute timeout and can be adjusted server-side with `DEPLOYMENT_DOCKER_TIMEOUT_MS`, capped at 600000 milliseconds. Build output is streamed into bounded deployment logs, and timed-out child processes are terminated. The previous running deployment remains in place until the replacement is healthy. Failed builds and health checks preserve the previous deployment. Rollback starts the previous successful image and performs the same health check before switching traffic.

Deployment mutations use the existing GitHub session and project ownership checks, and are serialized per project/environment. Containers are created with no privileged mode, no host networking, no mounts, no Docker socket, bounded CPU/memory/PIDs, and server-generated names. Only deployment-owned containers can be stopped or replaced. External deployment providers, arbitrary Docker arguments, force operations, and deployment secrets are not supported.

Deployment APIs are available under `/api/deployments` and `/api/projects/[id]/environments`; the UI is available at `/deployments`. Logs are persisted with bounded line and total history limits. PostgreSQL migrations are required before using deployment persistence:

```bash
npm run db:migrate
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

# Git Phase 7 test

# Git Phase 7 test

# Git Phase 7 test
