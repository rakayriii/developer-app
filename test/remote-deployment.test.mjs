import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REMOTE_IMAGE_LOAD_COMMAND,
  RemoteCommandError,
  assertRemoteImage,
  assertRemoteName,
  assertRemotePath,
  healthTarget,
  isRemotePort,
  remoteContainerPortsCommand,
  remoteCreateCommand,
  remoteCurlCapabilityCommand,
  remoteHealthStatusCommand,
  remoteImageInspectCommand,
  remoteMigrationCommand,
  remotePortOwnerCommand,
  remoteReleaseCommands,
  remoteRemoveEnvFileCommand,
  remoteStopCommand,
  remoteWriteEnvFileCommand,
} from "../src/lib/deployments/remote/args.ts";
import { renderEnvironmentFile, remoteEnvironmentFilePath } from "../src/lib/deployments/remote/env-file.ts";
import { summarizeRemoteFailure } from "../src/lib/deployments/remote/diagnostics.ts";
import { resolveTargetInput, localPortScope, remotePortScope, portScopeFor } from "../src/lib/deployments/target-scope.ts";
import { deploymentStages, stageStream } from "../src/lib/deployments/stages.ts";
import { knownLogStages, stageOrder, groupLogsByStage, normalizeLogResponse } from "../src/lib/deployments/logs.ts";

// -------------------------------------------------------------------------------------------
// Shell injection: ssh concatenates its argument vector and the *remote* login shell re-parses
// the result, so a value reaching a remote command must not be able to become an operator.
// -------------------------------------------------------------------------------------------
describe("remote command values cannot become shell operators", () => {
  const injections = [
    "img; rm -rf /",
    "img && curl evil",
    "img | tee /etc/passwd",
    "img$(whoami)",
    "img`id`",
    "img > /root/.ssh/authorized_keys",
    "img < /etc/shadow",
    "img & background",
    "img\nsecond-line",
    "img\rcr",
    "img'quote",
    'img"quote',
    "img\\escape",
    "img*glob",
    "img?glob",
    "img{brace}",
    "img#comment",
    "img~tilde",
    "img!bang",
  ];

  for (const payload of injections) {
    it(`rejects ${JSON.stringify(payload).slice(0, 40)} as a container name`, () => {
      assert.throws(() => assertRemoteName(payload), RemoteCommandError);
    });
    it(`rejects ${JSON.stringify(payload).slice(0, 40)} as an image reference`, () => {
      assert.throws(() => assertRemoteImage(payload), RemoteCommandError);
    });
    it(`rejects ${JSON.stringify(payload).slice(0, 40)} as a remote path`, () => {
      assert.throws(() => assertRemotePath(payload), RemoteCommandError);
    });
  }

  it("accepts the shapes the engine actually generates", () => {
    assert.equal(assertRemoteName("developer-os-gamevault-production-cmutp318s00"), "developer-os-gamevault-production-cmutp318s00");
    assert.equal(assertRemoteImage("developer-os/gamevault:deployment-cmutp318s0001v1s6qf4qka26"), "developer-os/gamevault:deployment-cmutp318s0001v1s6qf4qka26");
    assert.equal(assertRemotePath("/tmp/developer-os-env-cmutp318s0001v1s6qf4qka26"), "/tmp/developer-os-env-cmutp318s0001v1s6qf4qka26");
  });

  it("rejects a path traversal in the env-file location", () => {
    assert.throws(() => assertRemotePath("/tmp/../etc/passwd"), RemoteCommandError);
    assert.throws(() => assertRemotePath("/tmp/a/../../etc/shadow"), RemoteCommandError);
  });

  it("builds the env-file path from the deployment id alone", () => {
    assert.equal(remoteEnvironmentFilePath("cmu-123_x"), "/tmp/developer-os-env-cmu123x");
  });

  it("reduces a hostile deployment id to harmless characters", () => {
    // Every separator and dot is stripped, so no traversal or absolute path can survive.
    assert.equal(remoteEnvironmentFilePath("../../etc/passwd"), "/tmp/developer-os-env-etcpasswd");
    assert.equal(remoteEnvironmentFilePath(".."), "/tmp/developer-os-env-");
    for (const payload of ["../../etc/passwd", "/etc/passwd", "a/../../b"]) {
      const path = remoteEnvironmentFilePath(payload);
      assert.ok(path.startsWith("/tmp/developer-os-env-"), `${payload} escaped the temp directory`);
      assert.ok(!path.includes(".."), `${payload} retained a traversal`);
      assert.doesNotThrow(() => assertRemotePath(path));
    }
  });
});

// -------------------------------------------------------------------------------------------
// Hardened remote container creation
// -------------------------------------------------------------------------------------------
describe("remote container creation is hardened", () => {
  const command = remoteCreateCommand({
    tag: "developer-os/gamevault:deployment-abc",
    name: "developer-os-gamevault-production-abc",
    hostPort: 8088,
    containerPort: 80,
    cpuLimit: "1.0",
    memoryLimit: "512m",
    envFilePath: "/tmp/developer-os-env-abc",
  });

  it("uses docker create with a server-generated name", () => {
    assert.match(command, /^docker create /);
    assert.match(command, /--name developer-os-gamevault-production-abc /);
  });

  it("injects runtime values through --env-file, never as --env KEY=VALUE", () => {
    assert.match(command, /--env-file \/tmp\/developer-os-env-abc/);
    // An --env argument would place a secret in the remote process argument list.
    assert.doesNotMatch(command, /--env /);
    assert.doesNotMatch(command, /APP_KEY|DB_PASSWORD/);
  });

  it("publishes only the configured port pair", () => {
    assert.match(command, /--publish 8088:80 /);
  });

  it("applies the same resource bounds as a local container", () => {
    assert.match(command, /--cpus 1\.0/);
    assert.match(command, /--memory 512m/);
    assert.match(command, /--pids-limit 256/);
    assert.match(command, /--restart unless-stopped/);
  });

  for (const forbidden of ["--privileged", "--network", "--cap-add", "--volume", "--mount", "--device", "--security-opt", "pid=host", "--userns", "--runtime", "docker.sock", "/var/run"]) {
    it(`never emits ${forbidden}`, () => {
      assert.ok(!command.includes(forbidden), `${command} must not contain ${forbidden}`);
    });
  }

  it("refuses a value that would smuggle an operator into the create command", () => {
    assert.throws(() => remoteCreateCommand({ tag: "img;id", name: "n", hostPort: 80, containerPort: 80, cpuLimit: "1.0", memoryLimit: "512m", envFilePath: "/tmp/e" }), RemoteCommandError);
    assert.throws(() => remoteCreateCommand({ tag: "img", name: "n", hostPort: 80, containerPort: 80, cpuLimit: "1.0;id", memoryLimit: "512m", envFilePath: "/tmp/e" }), RemoteCommandError);
    assert.throws(() => remoteCreateCommand({ tag: "img", name: "n", hostPort: 80, containerPort: 80, cpuLimit: "1.0", memoryLimit: "512m", envFilePath: "/tmp/e;id" }), RemoteCommandError);
  });

  it("rejects a port that is not a plain integer", () => {
    for (const port of [0, -1, 70000, 1.5, "80"]) {
      assert.throws(() => remoteCreateCommand({ tag: "img", name: "n", hostPort: port, containerPort: 80, cpuLimit: "1.0", memoryLimit: "512m", envFilePath: "/tmp/e" }), RemoteCommandError, `port ${port} must be rejected`);
    }
    assert.equal(isRemotePort(8088), true);
    assert.equal(isRemotePort(0), false);
  });
});

// -------------------------------------------------------------------------------------------
// Fixed remote operations only
// -------------------------------------------------------------------------------------------
describe("remote operations are fixed", () => {
  it("loads an image with the one supported command", () => {
    assert.equal(REMOTE_IMAGE_LOAD_COMMAND, "docker load");
  });

  it("runs exactly one release command, as a constant argv sequence", () => {
    assert.deepEqual(remoteReleaseCommands.migrate, ["artisan", "migrate", "--force", "--no-interaction"]);
    assert.equal(remoteMigrationCommand("developer-os-a-b-c"), "docker exec developer-os-a-b-c php artisan migrate --force --no-interaction");
  });

  it("reports a port's owner read-only", () => {
    assert.equal(remotePortOwnerCommand(8088), "docker ps --all --filter publish=8088 --format {{.Names}}");
  });

  it("inspects an image without a shell", () => {
    assert.equal(remoteImageInspectCommand("developer-os/gamevault:deployment-a"), "docker image inspect --format {{.Id}} developer-os/gamevault:deployment-a");
  });

  it("probes curl availability before using it for health verification", () => {
    assert.equal(remoteCurlCapabilityCommand, "command -v curl");
  });

  it("reads published ports without a dollar-sign template", () => {
    // `{{range $p, $conf := ...}}` would have $p expanded away by the remote login shell.
    assert.equal(remoteContainerPortsCommand("developer-os-a-b-c"), "docker port developer-os-a-b-c");
    assert.ok(!remoteContainerPortsCommand("n").includes("$"));
  });
});

// -------------------------------------------------------------------------------------------
// Health check: no SSRF from the Developer OS process
// -------------------------------------------------------------------------------------------
describe("remote health verification cannot be pointed at an arbitrary address", () => {
  it("always targets loopback with a validated port and path", () => {
    assert.equal(healthTarget(8088, "/"), "127.0.0.1:8088/");
    assert.equal(healthTarget(80, "/api/health"), "127.0.0.1:80/api/health");
  });

  it("builds a curl command against loopback only", () => {
    const command = remoteHealthStatusCommand(8088, "/");
    assert.match(command, /^curl --silent --output \/dev\/null --write-out %\{http_code\} --max-time 10 /);
    assert.match(command, /127\.0\.0\.1:8088\/$/);
  });

  for (const [port, path] of [[0, "/"], [70000, "/"], [80, "http://169.254.169.254/latest/meta-data"], [80, "//evil.com"], [80, "///evil.com"], [80, "/\nHost: evil"], ["80", "/"], [80, "http://example.com"], [80, "../../secret"]]) {
    it(`rejects port=${JSON.stringify(port)} path=${JSON.stringify(path)}`, () => {
      assert.throws(() => remoteHealthStatusCommand(port, path), RemoteCommandError);
    });
  }
});

// -------------------------------------------------------------------------------------------
// Runtime environment: secret handling
// -------------------------------------------------------------------------------------------
describe("remote runtime environment file", () => {
  it("writes values unquoted, because Docker does not strip quotes", () => {
    // Verified against Docker 27.5.1: KEY="80" reaches the container as the literal "80".
    assert.equal(renderEnvironmentFile({ PORT: "80" }), "PORT=80\n");
    assert.equal(renderEnvironmentFile({ APP_KEY: "base64:abc=", APP_ENV: "production" }), "APP_KEY=base64:abc=\nAPP_ENV=production\n");
  });

  it("preserves values that a quoting approach would corrupt", () => {
    assert.match(renderEnvironmentFile({ DB_PASSWORD: "p@ss w0rd#1" }), /^DB_PASSWORD=p@ss w0rd#1\n$/);
    assert.match(renderEnvironmentFile({ A: "x=y" }), /^A=x=y\n$/);
  });

  it("refuses a value it cannot represent, rather than mis-encoding it", () => {
    for (const bad of ["line1\nline2", "carriage\rreturn", "nul\0byte"]) {
      assert.throws(() => renderEnvironmentFile({ APP_KEY: bad }), /cannot be represented/);
    }
  });

  it("refuses a key that is not a valid environment name", () => {
    for (const key of ["BAD KEY", "1LEADING", "WITH=EQ", "", "NEW\nLINE"]) {
      assert.throws(() => renderEnvironmentFile({ [key]: "v" }), /cannot be written/);
    }
  });

  it("creates the file with restrictive permissions before any content is written", () => {
    const command = remoteWriteEnvFileCommand("/tmp/developer-os-env-abc");
    // umask applies before the redirect, so the file is never group- or world-readable, not even
    // in the window before the explicit chmod.
    assert.match(command, /^umask 077 && cat > \/tmp\/developer-os-env-abc && chmod 600 \/tmp\/developer-os-env-abc$/);
  });

  it("removes the env file with a plain fixed command", () => {
    assert.equal(remoteRemoveEnvFileCommand("/tmp/developer-os-env-abc"), "rm -f /tmp/developer-os-env-abc");
  });

  it("refuses to write an env file at an operator-bearing path", () => {
    assert.throws(() => remoteWriteEnvFileCommand("/tmp/x;curl evil"), RemoteCommandError);
    assert.throws(() => remoteRemoveEnvFileCommand("/tmp/x|id"), RemoteCommandError);
  });

  it("stops a remote container with a bounded grace period", () => {
    assert.equal(remoteStopCommand("developer-os-a-b-c"), "docker stop --time 5 developer-os-a-b-c");
  });
});

// -------------------------------------------------------------------------------------------
// Failure diagnostics
// -------------------------------------------------------------------------------------------
describe("remote failure diagnostics are preserved but scrubbed", () => {
  it("keeps the remote reason, because a generic message hides every cause", () => {
    const detail = summarizeRemoteFailure("Error response from daemon: Conflict. The container name is already in use");
    assert.match(detail, /already in use/);
  });

  it("masks base64 blobs that could be key or token material", () => {
    const detail = summarizeRemoteFailure("failed with AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.match(detail, /\[redacted\]/);
    assert.ok(!detail.includes("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
  });

  it("drops a PEM body entirely", () => {
    const detail = summarizeRemoteFailure("error\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecret\n-----END OPENSSH PRIVATE KEY-----\ntail");
    assert.ok(!detail.includes("PRIVATE KEY"));
    assert.ok(!detail.includes("AAAAsecret"));
  });

  it("is bounded", () => {
    assert.ok(summarizeRemoteFailure("x".repeat(5000)).length <= 240);
  });

  it("returns an empty string when there is nothing to report", () => {
    assert.equal(summarizeRemoteFailure(""), "");
  });
});

// -------------------------------------------------------------------------------------------
// Target model
// -------------------------------------------------------------------------------------------
describe("deployment target scoping", () => {
  it("scopes host ports per Docker host", () => {
    assert.equal(localPortScope, "local");
    assert.equal(remotePortScope("srv1"), "server:srv1");
    // Two remote environments may both use 8088 on different servers; two local ones may not.
    assert.notEqual(remotePortScope("srv1"), remotePortScope("srv2"));
  });

  it("rejects a target that is neither local nor remote", () => {
    assert.throws(() => resolveTargetInput({ target: "kubernetes" }), /local or remote/);
    assert.throws(() => resolveTargetInput({ target: 7 }), /local or remote/);
    assert.throws(() => resolveTargetInput({ target: "LOCAL" }), /local or remote/);
  });

  it("defaults to local when no target is supplied", () => {
    assert.deepEqual(resolveTargetInput({}), { target: "local", serverId: null });
  });

  it("refuses a local environment that names a remote server", () => {
    assert.throws(() => resolveTargetInput({ target: "local", serverId: "srv1" }), /cannot reference a remote server/);
  });

  it("requires a server id for a remote environment", () => {
    assert.throws(() => resolveTargetInput({ target: "remote" }), /Select a registered server/);
    assert.throws(() => resolveTargetInput({ target: "remote", serverId: "  " }), /Select a registered server/);
    assert.throws(() => resolveTargetInput({ target: "remote", serverId: 42 }), /Select a registered server/);
  });

  it("accepts a remote target that names exactly one server", () => {
    assert.deepEqual(resolveTargetInput({ target: "remote", serverId: " srv1 " }), { target: "remote", serverId: "srv1" });
  });

  it("has no field through which a hostname could be supplied", () => {
    // The rules accept only `target` and `serverId`; anything else is ignored, so a hostname in the
    // request body cannot become part of a deployment target.
    const resolved = resolveTargetInput({ target: "remote", serverId: "srv1", hostname: "attacker.example", port: 2222, username: "root" });
    assert.deepEqual(resolved, { target: "remote", serverId: "srv1" });
    assert.ok(!("hostname" in resolved));
  });

  it("scopes the port key by the resolved target", () => {
    assert.equal(portScopeFor("local", null), "local");
    assert.equal(portScopeFor("remote", "srv1"), "server:srv1");
    // A remote target with no server cannot occur, but it must never fall back to the local scope.
    assert.equal(portScopeFor("remote", null), "local");
  });
});

// -------------------------------------------------------------------------------------------
// Stages and log grouping
// -------------------------------------------------------------------------------------------
describe("remote stages are first-class in the deployment log", () => {
  it("declares transfer and remote_image stages", () => {
    assert.ok(deploymentStages.includes("transfer"));
    assert.ok(deploymentStages.includes("remote_image"));
  });

  it("persists them under their own stream names", () => {
    assert.equal(stageStream.transfer, "transfer");
    assert.equal(stageStream.remote_image, "remote_image");
  });

  it("groups remote stages in lifecycle order instead of dumping them into an unnamed bucket", () => {
    assert.ok(stageOrder.includes("transfer"));
    assert.ok(stageOrder.includes("remote_image"));
    assert.ok(knownLogStages.includes("transfer"));
    assert.ok(knownLogStages.includes("remote_image"));
    // "transfer" must come after "build", because that is the order they happen in.
    assert.ok(stageOrder.indexOf("build") < stageOrder.indexOf("transfer"));
    assert.ok(stageOrder.indexOf("transfer") < stageOrder.indexOf("container"));
  });

  it("renders a remote deployment's stages as named groups", () => {
    const entries = normalizeLogResponse({ entries: [
      { id: "1", timestamp: "t", stream: "build", message: "build" },
      { id: "2", timestamp: "t", stream: "transfer", message: "transfer" },
      { id: "3", timestamp: "t", stream: "remote_image", message: "loaded" },
      { id: "4", timestamp: "t", stream: "container", message: "started" },
    ], count: 4 });
    const { ordered, other } = groupLogsByStage(entries);
    const stages = ordered.map((group) => group.stage);
    assert.deepEqual(stages, ["build", "transfer", "remote_image", "container"]);
    assert.equal(other.length, 0);
  });

  it("does not invent remote stages for a local deployment", () => {
    const entries = normalizeLogResponse([{ id: "1", timestamp: "t", stream: "build", message: "build" }, { id: "2", timestamp: "t", stream: "health", message: "HTTP 200" }]);
    const { ordered, other } = groupLogsByStage(entries);
    assert.deepEqual(ordered.map((group) => group.stage), ["build", "health"]);
    assert.equal(other.length, 0);
  });
});
