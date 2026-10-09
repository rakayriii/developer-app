// Runs once when a Next.js server instance starts.
//
// This is where the reconciliation scheduler is started, rather than in server.mjs: the custom server
// runs as plain Node and cannot import the application's TypeScript modules, whereas instrumentation is
// compiled into the server and shares the application's module graph.
//
// `register` must complete before the server handles requests, so nothing here is awaited. The scheduler
// installs a timer and returns immediately; the first reconciliation happens in the background after the
// application is already serving. Reconciliation never rebuilds or restarts anything.

export async function register() {
  // Next calls register in every runtime. Reconciliation needs Node for Docker and SSH.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { startReconciliationScheduler } = await import("@/lib/reliability/scheduler");
    startReconciliationScheduler();
  } catch (error) {
    // A scheduler that cannot start must not take the application down with it. Reconciliation is a
    // convenience for the operator; the deployment engine works without it.
    console.error(JSON.stringify({
      service: "reliability",
      event: "scheduler_start_failed",
      message: error instanceof Error ? error.message : "unknown",
    }));
  }
}