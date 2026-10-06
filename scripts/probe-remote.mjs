// Diagnostic probe: runs the real remote start path without the engine's failure cleanup, so the
// remote container can be inspected while it is failing.
import { readFileSync, existsSync } from "node:fs";
for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}
process.env.GIT_WORKSPACE_ROOT ||= "/home/skywalker";

const { prisma } = await import("../src/lib/db.ts");
const { resolveRuntimeEnvironment } = await import("../src/lib/deployments/runtime-store.ts");
const { openRemoteDeployment } = await import("../src/lib/deployments/remote/server.ts");
const { renderEnvironmentFile, remoteEnvironmentFilePath } = await import("../src/lib/deployments/remote-target.ts");
const { remoteWriteEnvironmentFile, remoteDockerCreate, remoteDockerStart, remoteContainerDiagnostics, remoteContainerRuntime } = await import("../src/lib/deployments/remote/docker.ts");
const { remoteCreateCommand } = await import("../src/lib/deployments/remote/args.ts");

const environmentId = process.argv[2];
if (!environmentId) throw new Error("usage: probe-remote.mjs <environmentId>");

const environment = await prisma.deploymentEnvironment.findUnique({ where: { id: environmentId }, include: { project: true } });
if (!environment?.serverId) throw new Error("environment has no server");

const tag = process.argv[3] || "developer-os/probe:latest";
const deploymentId = "probe00000000000000000000";
const runtime = await resolveRuntimeEnvironment(environmentId);

console.log("resolved variable names:", Object.keys(runtime.variables).sort().join(", "));
console.log("unreadable secrets:", runtime.unreadable.join(", ") || "none");
console.log("APP_KEY present:", "APP_KEY" in runtime.variables, "| length:", (runtime.variables.APP_KEY || "").length);
console.log("PORT would be:", environment.containerPort);

const contents = renderEnvironmentFile({ PORT: String(environment.containerPort), ...runtime.variables });
// Only the shape and the variable names are printed; no secret value is ever displayed.
console.log("env file lines:", contents.split("\n").filter(Boolean).length);
console.log("env file keys:", contents.split("\n").filter(Boolean).map((l) => l.split("=")[0]).join(", "));
console.log("value lengths:", contents.split("\n").filter(Boolean).map((l) => `${l.split("=")[0]}:${l.split("=").slice(1).join("=").length}`).join(" "));

const context = await openRemoteDeployment(environment.project.userId, environment.serverId);
const path = remoteEnvironmentFilePath(deploymentId);
const name = `developer-os-probe-${deploymentId.slice(0, 8)}`;

await remoteWriteEnvironmentFile(context.transport, path, contents);
console.log("\nenv file written to", path);

const created = await remoteDockerCreate(context.transport, remoteCreateCommand({ tag, name, hostPort: environment.hostPort, containerPort: environment.containerPort, cpuLimit: environment.cpuLimit, memoryLimit: environment.memoryLimit, envFilePath: path }));
console.log("created container:", created);
await remoteDockerStart(context.transport, name);
console.log("start issued");

await new Promise((resolve) => setTimeout(resolve, 12000));
const runtimeInfo = await remoteContainerRuntime(context.transport, name);
console.log("runtime:", JSON.stringify(runtimeInfo, null, 2));
const diagnostics = await remoteContainerDiagnostics(context.transport, name);
console.log("\ndiagnostics state:", diagnostics.state);
console.log("logs:\n", diagnostics.logs);

await context.transport.close();
await prisma.$disconnect();
