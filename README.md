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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
