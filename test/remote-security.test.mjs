import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { remoteCreateCommand } from "../src/lib/deployments/remote/args.ts";

// The remote deployment path is the part of this application that reaches another machine. These tests
// assert structural properties that unit tests cannot: that no generic execution entry point exists,
// that no shell is ever enabled, and that no forbidden container flag is present anywhere.

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

function walk(directory, extensions) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const nested = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(nested, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [nested] : [];
  });
}

const remoteSources = [
  ...walk("src/lib/deployments/remote", [".ts"]),
  "src/lib/deployments/remote-target.ts",
  "src/lib/deployments/target-runtime.ts",
  "src/lib/deployments/target-scope.ts",
];
const allAppSources = [...walk("src", [".ts", ".tsx"]), "server.mjs", ...walk("server", [".mjs"])];

// Strips comments so a prohibition can be named in an explanation without tripping the check.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("no shell anywhere in the deployment path", () => {
  it("never enables shell execution", () => {
    for (const file of [...remoteSources, "src/lib/deployments/service.ts", "src/lib/deployments/docker.ts", "src/lib/docker/client.ts", "src/lib/servers/ssh.ts"]) {
      const source = code(read(file));
      assert.doesNotMatch(source, /shell:\s*true/, `${file} enables a shell`);
    }
  });

  it("never uses a shell pipeline or a shell command string for an image transfer", () => {
    for (const file of remoteSources) {
      const source = code(read(file));
      // A pipeline would mean one side is a shell. The transfer is a pipe between two child processes.
      assert.doesNotMatch(source, /`[^`]*\|\s*(ssh|docker)/, `${file} builds a shell pipeline`);
      assert.doesNotMatch(source, /execSync|spawnSync\(\s*["'`](?:sh|bash)/, `${file} runs a shell`);
    }
  });

  it("spans the image transfer between two child processes, not a shell pipeline", () => {
    const transfer = code(read("src/lib/deployments/remote/docker.ts"));
    assert.match(transfer, /spawn\(\s*["']docker["']/);
    assert.match(transfer, /transport\.pipe\(/);
    assert.match(transfer, /stdout/);
  });

  it("uses one fixed remote command for the image load", () => {
    assert.match(read("src/lib/deployments/remote/args.ts"), /REMOTE_IMAGE_LOAD_COMMAND = remoteCommand\("docker", "load"\)/);
  });
});

describe("no generic remote execution entry point", () => {
  it("exposes no remoteExec-style helper", () => {
    for (const file of remoteSources) {
      const source = code(read(file));
      assert.doesNotMatch(source, /export\s+(async\s+)?function\s+remoteExec\b/, `${file} exposes remoteExec`);
      assert.doesNotMatch(source, /runRemoteCommand\s*\(/, `${file} exposes a generic remote command runner`);
    }
  });

  it("has no API route that accepts a command", () => {
    for (const file of walk("src/app/api", ["route.ts"])) {
      const source = code(read(file));
      assert.doesNotMatch(source, /body\.command/, `${file} reads a command from the request body`);
      assert.doesNotMatch(source, /body\.args/, `${file} reads arguments from the request body`);
      assert.doesNotMatch(source, /body\.script/, `${file} reads a script from the request body`);
    }
  });

  it("offers no POST /api/servers/[id]/exec endpoint", () => {
    assert.ok(!existsSync(path.join(root, "src/app/api/servers/[id]/exec")), "a generic server exec route exists");
  });

  it("only exposes fixed per-operation server routes", () => {
    const routes = walk("src/app/api/servers", ["route.ts"]).map((file) => file.replace("src/app", "").replace(/\/route\.ts$/, ""));
    assert.deepEqual(routes.sort(), ["/api/servers", "/api/servers/[id]", "/api/servers/[id]/checks", "/api/servers/[id]/refresh", "/api/servers/[id]/test", "/api/servers/[id]/trust"]);
  });

  it("never accepts an image, container name, or docker flag from the browser", () => {
    for (const file of walk("src/app/api/deployments", ["route.ts"])) {
      const source = code(read(file));
      for (const forbidden of ["body.imageTag", "body.containerName", "body.image", "body.dockerCommand", "body.hostname"]) {
        assert.doesNotMatch(source, new RegExp(forbidden.replace(/\./g, "\\.")), `${file} reads ${forbidden}`);
      }
    }
  });
});

describe("no forbidden container option anywhere in the application", () => {
  // The Docker socket is deliberately absent here: the server connects to the *host* daemon through it,
  // but no deployed container may ever be given it. That is asserted separately below.
  const forbidden = ["--privileged", "--cap-add", "--volume", "--mount", "--device", "--security-opt", "pid=host", "--userns", "--runtime", "host network", "--network host"];

  for (const flag of forbidden) {
    it(`never emits ${flag}`, () => {
      for (const file of allAppSources) {
        const source = code(read(file));
        assert.ok(!source.includes(flag), `${file} contains ${flag}`);
      }
    });
  }

  it("mounts nothing into a deployed container", () => {
    for (const file of [...remoteSources, "src/lib/deployments/docker.ts"]) {
      const source = code(read(file));
      // Flag-level checks only. A bare "-v" is not searched for, because the legitimate
      // `command -v curl` capability probe uses it and is not a volume.
      assert.doesNotMatch(source, /--volume|--mount|-v=|Binds:/, `${file} binds a host path into the container`);
      assert.doesNotMatch(source, /\bBinds\b/, `${file} references a bind mount`);
    }
  });

  it("emits a create command with no bind flag at all", () => {
    // Behavioural: this is the exact string the remote login shell receives, not a source fragment.
    const emitted = remoteCreateCommand({
      tag: "developer-os/gamevault:deployment-abc",
      name: "developer-os-gamevault-production-abc",
      hostPort: 8088,
      containerPort: 80,
      cpuLimit: "1.0",
      memoryLimit: "512m",
      envFilePath: "/tmp/developer-os-env-abc",
    });
    for (const flag of ["-v", "--volume", "--mount", "--privileged", "--network", "--cap-add", "--device", "--security-opt", "--userns", "--runtime", "/var/run"]) {
      assert.ok(!emitted.includes(flag), `the emitted remote create command must not contain ${flag}: ${emitted}`);
    }
  });

  it("never exposes the host Docker socket to a deployed container", () => {
    for (const file of [...remoteSources, "src/lib/deployments/docker.ts", "src/lib/deployments/service.ts"]) {
      assert.ok(!code(read(file)).includes("/var/run/docker.sock"), `${file} references the Docker socket`);
      assert.doesNotMatch(code(read(file)), /docker\.sock/, `${file} mounts or references the Docker socket`);
    }
  });
});

describe("SSH hardening is shared by probes and deployments", () => {
  const ssh = code(read("src/lib/servers/ssh.ts"));

  it("keeps every hardening option on the single session used by both paths", () => {
    for (const option of [
      "StrictHostKeyChecking=yes",
      "BatchMode=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "PreferredAuthentications=publickey",
      "IdentitiesOnly=yes",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "RequestTTY=no",
      "NumberOfPasswordPrompts=0",
    ]) {
      assert.ok(ssh.includes(`"${option}"`), `missing ${option}`);
    }
  });

  it("writes the credential to a 0600 file and removes the directory afterwards", () => {
    assert.match(ssh, /writeFile\(keyPath, options\.privateKey, \{ mode: 0o600 \}\)/);
    assert.match(ssh, /rm\(directory, \{ recursive: true, force: true \}\)/);
  });

  it("derives the pinned known_hosts from the stored key line", () => {
    assert.match(ssh, /writeFile\(knownHostsPath, `\$\{options\.hostKeyLine\}\\n`/);
  });

  it("bounds output and timeouts with server-side constants", () => {
    assert.match(ssh, /export const sshCommandTimeoutMs = \d+/);
    assert.match(ssh, /export const sshMaxOutputBytes = /);
    assert.match(ssh, /\.slice\(0, sshMaxOutputBytes\)/);
  });
});

describe("deployment targets cannot be smuggled past the environment", () => {
  it("records the target and server on the deployment itself, from the environment", () => {
    const service = code(read("src/lib/deployments/service.ts"));
    assert.match(service, /target: environment\.target/);
    assert.match(service, /serverId: environment\.serverId/);
  });

  it("copies the target onto a redeploy rather than rebuilding it from the request", () => {
    const service = code(read("src/lib/deployments/service.ts"));
    assert.match(service, /redeployDeployment[\s\S]{0,900}createDeployment\(source\.projectId, source\.environmentId\)/);
  });

  it("scopes rollback candidates to the same server", () => {
    const service = code(read("src/lib/deployments/service.ts"));
    assert.match(service, /candidate\.serverId !== current\.serverId/);
    assert.match(service, /target\.serverId !== current\.serverId/);
  });

  it("verifies the rollback image still exists on the target", () => {
    const service = code(read("src/lib/deployments/service.ts"));
    assert.match(service, /verifyRollbackImage/);
    assert.match(service, /remote_rollback_image_missing/);
  });

  it("never removes an unrelated container holding the remote port", () => {
    const remote = code(read("src/lib/deployments/remote-target.ts"));
    // The port owner is inspected, and a leftover owner is a hard failure rather than something to stop.
    assert.match(remote, /remotePortOwner\(transport, hostPort\)/);
    assert.match(remote, /remote_port_in_use/);
    const stopCall = remote.slice(remote.indexOf("releaseHostPort"), remote.indexOf("transferImage,"));
    assert.ok(!/remoteDockerStop\([^)]*owner/.test(stopCall), "the port owner is stopped without an ownership check");
  });

  it("only ever stops containers whose recorded name it owns", () => {
    const remote = code(read("src/lib/deployments/remote-target.ts"));
    const release = remote.slice(remote.indexOf("releaseHostPort"), remote.indexOf("transferImage,"));
    assert.match(release, /incumbent\.containerName\.startsWith\("developer-os-"\)/);
    assert.match(release, /await existsByName\(incumbent\.containerName\)/);
  });
});

describe("the migration is additive and preserves existing deployments", () => {
  const migration = read("prisma/migrations/0008_remote_deployment/migration.sql");

  it("defaults every pre-existing row to the local target", () => {
    const targetColumns = migration.match(/ADD COLUMN "target" "DeploymentTarget" NOT NULL DEFAULT 'local'/g) || [];
    assert.equal(targetColumns.length, 2, "both Deployment and DeploymentEnvironment must default to local");
    // The port scope also defaults to local, which is what preserves the original single-host guard.
    assert.match(migration, /ADD COLUMN "portScopeKey" TEXT NOT NULL DEFAULT 'local'/);
  });

  it("keeps existing host-port uniqueness by scoping it rather than dropping it", () => {
    assert.match(migration, /ADD COLUMN "portScopeKey" TEXT NOT NULL DEFAULT 'local'/);
    assert.match(migration, /CREATE UNIQUE INDEX "DeploymentEnvironment_portScopeKey_hostPort_key"/);
  });

  it("restricts deletion of a server that still hosts something", () => {
    assert.match(migration, /ON DELETE RESTRICT/);
    assert.equal((migration.match(/ON DELETE RESTRICT/g) || []).length, 2);
  });

  it("never drops or rewrites a column", () => {
    assert.doesNotMatch(code(migration), /DROP COLUMN/);
    assert.doesNotMatch(code(migration), /ALTER COLUMN/);
    assert.doesNotMatch(code(migration), /DELETE FROM/);
    assert.doesNotMatch(code(migration), /TRUNCATE/);
  });
});

describe("secrets stay out of the remote process table and the logs", () => {
  it("injects remote runtime values only through an env file", () => {
    const target = code(read("src/lib/deployments/remote-target.ts"));
    assert.match(target, /remoteWriteEnvironmentFile/);
    assert.match(target, /renderEnvironmentFile/);
  });

  it("removes the env file on both the success and the failure path", () => {
    const target = code(read("src/lib/deployments/remote-target.ts"));
    const start = target.slice(target.indexOf("start: async"), target.indexOf("runRelease:"));
    assert.match(start, /finally\s*\{[\s\S]*remoteRemoveEnvironmentFile/);
  });

  it("never puts a runtime value into a remote command argument", () => {
    const args = code(read("src/lib/deployments/remote/args.ts"));
    assert.doesNotMatch(args, /--env["',]/);
    assert.match(args, /--env-file/);
  });

  it("redacts secret values from every remote log line", () => {
    const service = code(read("src/lib/deployments/service.ts"));
    assert.match(service, /redactSecrets\(message, secretValues\)/);
  });

  it("scrubs remote diagnostics before they can be persisted", () => {
    const diagnostics = code(read("src/lib/deployments/remote/diagnostics.ts"));
    assert.match(diagnostics, /PRIVATE KEY/);
    assert.match(diagnostics, /\[redacted\]/);
    assert.match(diagnostics, /\.slice\(0, 240\)/);
  });

  it("requests only allowlisted runtime fields from the remote daemon", () => {
    const args = code(read("src/lib/deployments/remote/args.ts"));
    const runtimeFields = args.slice(args.indexOf("remoteRuntimeFields"));
    for (const forbidden of ["Config.Env", "Config.Cmd", "Mounts", "Labels", "HostConfig.Privileged"]) {
      assert.ok(!runtimeFields.slice(0, 1200).includes(forbidden), `the runtime projection requests ${forbidden}`);
    }
  });
});
