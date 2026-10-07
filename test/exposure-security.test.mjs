import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// SQL comments are stripped too, so a migration's own prose cannot satisfy or trip a statement check.
const sql = (source) => source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

function walk(directory, extensions) {
  const absolute = path.join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const nested = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(nested, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [nested] : [];
  });
}

const exposureSources = [...walk("src/lib/exposure", [".ts"]), "src/lib/deployments/remote/caddy.ts", "src/lib/deployments/remote/proxy.ts", "src/app/api/domains/route.ts", "src/app/api/domains/[id]/route.ts", "src/app/api/domains/proxy/route.ts"];
const allAppSources = [...walk("src", [".ts", ".tsx"]), "server.mjs", ...walk("server", [".mjs"])];

describe("exposure adds no shell and no new capability", () => {
  it("never enables shell execution", () => {
    for (const file of exposureSources) assert.doesNotMatch(code(read(file)), /shell:\s*true/, `${file} enables a shell`);
  });

  it("never builds a shell pipeline", () => {
    for (const file of exposureSources) {
      assert.doesNotMatch(code(read(file)), /`[^`]*\|\s*(ssh|docker|cat)/, `${file} builds a pipeline`);
      assert.doesNotMatch(code(read(file)), /execSync|spawnSync\(\s*["'`](?:sh|bash)/, `${file} runs a shell`);
    }
  });

  it("exposes no generic remote command entry point", () => {
    for (const file of exposureSources) {
      assert.doesNotMatch(code(read(file)), /export\s+(async\s+)?function\s+remoteExec\b/, `${file} exposes remoteExec`);
      assert.doesNotMatch(code(read(file)), /runRemoteCommand\s*\(/, `${file} exposes a generic remote runner`);
    }
  });

  it("offers no endpoint that accepts a command, script, or config from the browser", () => {
    for (const file of walk("src/app/api/domains", ["route.ts"])) {
      const source = code(read(file));
      for (const field of ["command", "script", "config", "caddyfile", "upstream", "image", "flags"]) {
        assert.doesNotMatch(source, new RegExp(`body\\.${field}\\b`), `${file} reads body.${field}`);
      }
    }
  });
});

describe("the proxy container is fixed and unprivileged", () => {
  const caddy = read("src/lib/deployments/remote/caddy.ts");

  it("uses a constant image and a server-derived container name", () => {
    assert.match(caddy, /export const CADDY_IMAGE = "caddy:2-alpine";/);
    assert.match(caddy, /export function caddyContainerName\(serverId: string\)/);
    // The name is a function of the server id alone, so a caller cannot choose it.
    assert.doesNotMatch(caddy, /caddyContainerName\([^)]*(body|request|input)/);
  });

  it("publishes only 80 and 443", () => {
    assert.match(caddy, /--publish \$\{CADDY_HTTP_PORT\}:80 --publish \$\{CADDY_HTTPS_PORT\}:443/);
    assert.equal(caddy.includes("CADDY_HTTP_PORT = 80"), true);
    assert.equal(caddy.includes("CADDY_HTTPS_PORT = 443"), true);
  });

  for (const forbidden of ["--privileged", "--cap-add", "--device", "--security-opt", "pid=host", "--userns", "--runtime", "docker.sock"]) {
    it(`never emits ${forbidden}`, () => assert.ok(!caddy.includes(forbidden), `caddy.ts must not contain ${forbidden}`));
  }

  it("is bound and bounded like every other managed container", () => {
    assert.match(caddy, /"--restart", "unless-stopped"/);
    assert.match(caddy, /"--memory", "512m"/);
    assert.match(caddy, /"--pids-limit", "256"/);
  });

  it("mounts only the proxy's own data directory", () => {
    assert.match(caddy, /--mount", `type=bind,src=\$\{caddyDataDirectory\},dst=\/data`/);
    // One bind, to a fixed path. Nothing else is mounted.
    assert.equal((caddy.match(/--mount/g) || []).length, 1);
  });

  it("reloads rather than restarting, so traffic is not dropped", () => {
    assert.match(caddy, /caddy", "reload"/);
  });

  it("validates the configuration before adopting it", () => {
    assert.match(caddy, /caddy", "validate"/);
    const proxy = read("src/lib/deployments/remote/proxy.ts");
    assert.match(proxy, /remoteWriteAndReloadCaddy/);
    assert.match(proxy, /caddyValidateCommand/);
    assert.ok(proxy.indexOf("caddyValidateCommand") < proxy.indexOf("caddyReloadCommand") || /caddyReloadCommand/.test(proxy));
    assert.match(proxy, /Validating before reloading/);
  });
});

describe("the configuration file is written safely", () => {
  const caddy = read("src/lib/deployments/remote/caddy.ts");

  it("creates it under a restrictive umask and never world-readable", () => {
    assert.match(caddy, /umask 077 && mkdir -p/);
    assert.match(caddy, /&& chmod 600/);
  });

  it("sends the configuration over stdin rather than on a command line", () => {
    // The rendered file is large and operator-influenced; it never belongs in argv.
    assert.doesNotMatch(caddy, /remoteCommand\([^)]*renderCaddyfile/);
    assert.match(read("src/lib/deployments/remote/proxy.ts"), /transport\.pipe\(/);
  });

  it("never publishes the admin port, so the admin API is unreachable from outside", () => {
    // The admin endpoint must stay bound to loopback because `caddy reload` needs it. The containment
    // is the published port list: only 80 and 443 leave the container.
    const caddy = code(read("src/lib/deployments/remote/caddy.ts"));
    // Exactly two --publish flags. Their values come from fixed constants, not from a request.
    assert.equal((caddy.match(/--publish/g) || []).length, 2, "exactly two ports may be published");
    assert.match(caddy, /export const CADDY_HTTP_PORT = 80;/);
    assert.match(caddy, /export const CADDY_HTTPS_PORT = 443;/);
    assert.match(caddy, /--publish \$\{CADDY_HTTP_PORT\}:80 --publish \$\{CADDY_HTTPS_PORT\}:443/);
    assert.ok(!/2019/.test(caddy), "the admin port must never be published");
    const config = read("src/lib/exposure/caddy.ts");
    assert.match(config, /export const caddyAdminAddress = "localhost:2019"/);
    assert.match(config, /admin \$\{caddyAdminAddress\}/);
  });
});

describe("ownership boundaries are enforced in the query, not by a later check", () => {
  const service = code(read("src/lib/exposure/service.ts"));

  it("scopes every read by the authenticated user through the server", () => {
    assert.match(service, /server: \{ userId \}/);
    assert.match(service, /where: \{ id, server: \{ userId \} \}/);
  });

  it("requires the deployment to belong to the user and to be remote", () => {
    assert.match(service, /project: \{ userId \}/);
    assert.match(service, /target: "remote"/);
  });

  it("takes the server from the deployment rather than the request", () => {
    // A separate serverId in the request would let an operator route a hostname at a host that does not
    // serve the application, so the deployment's own server is authoritative.
    assert.match(service, /if \(!deployment\.serverId\) throw new DomainError\("domain_server_required"/);
  });

  it("reports a missing or foreign domain as not found rather than forbidden", () => {
    assert.match(service, /domain_not_found/);
  });

  it("reconciles from the stored domains, never from a caller-supplied route list", () => {
    assert.match(service, /routesForServer\(serverId\)/);
    assert.doesNotMatch(service, /reconcileServer\([^)]*body\./);
  });
});

describe("a domain cannot outlive the thing it routes to", () => {
  it("withdraws the hostname when its deployment stops serving", () => {
    const service = code(read("src/lib/exposure/service.ts"));
    assert.match(service, /const routableStatuses = \["running", "unhealthy"\]/);
    assert.match(service, /deployment_not_serving/);
  });

  it("refuses two domains claiming the same name on one server", () => {
    assert.match(read("prisma/schema.prisma"), /@@unique\(\[serverId, hostname\]\)/);
    assert.match(code(read("src/lib/exposure/service.ts")), /domain_already_exists/);
  });

  it("cascades from the deployment and restricts from the server", () => {
    const migration = read("prisma/migrations/0009_application_exposure/migration.sql");
    assert.match(migration, /"deploymentId"\) REFERENCES "Deployment"\("id"\) ON DELETE CASCADE/);
    assert.match(migration, /"serverId"\) REFERENCES "Server"\("id"\) ON DELETE RESTRICT/);
  });

  it("is additive: it rewrites no existing column and no existing row", () => {
    const migration = sql(read("prisma/migrations/0009_application_exposure/migration.sql"));
    assert.doesNotMatch(migration, /ALTER COLUMN/);
    assert.doesNotMatch(migration, /DROP COLUMN|DROP TABLE|DROP INDEX/);
    // Scoped to statement starts: "ON DELETE CASCADE" is a required referential action on the new
    // foreign keys, not a statement that destroys anything.
    assert.doesNotMatch(migration, /^\s*(UPDATE|DELETE|TRUNCATE|ALTER TABLE\s+"(?!DeploymentDomain))/im);
    assert.match(migration, /ON DELETE CASCADE/);
    assert.match(migration, /ON DELETE RESTRICT/);
  });
});

describe("no forbidden container option anywhere in the application", () => {
  for (const flag of ["--privileged", "--cap-add", "--volume", "--device", "--security-opt", "pid=host", "--userns", "--runtime"]) {
    it(`never emits ${flag}`, () => {
      for (const file of allAppSources) assert.ok(!code(read(file)).includes(flag), `${file} contains ${flag}`);
    });
  }
});

describe("the deployment path is untouched by exposure", () => {
  it("adds no forbidden flag to the deployment container command", () => {
    for (const file of ["src/lib/deployments/remote/args.ts", "src/lib/deployments/docker.ts"]) {
      const source = code(read(file));
      assert.doesNotMatch(source, /--env /, `${file} must inject through an env file, not argv`);
    }
  });

  it("leaves the existing remote commands intact", () => {
    assert.match(read("src/lib/deployments/remote/args.ts"), /REMOTE_IMAGE_LOAD_COMMAND = remoteCommand\("docker", "load"\)/);
    assert.match(read("src/lib/deployments/remote/args.ts"), /remoteReleaseCommands = Object\.freeze\(\{ migrate:/);
  });
});
// -------------------------------------------------------------------------------------------
describe("domain endpoints keep the API contract", () => {
  const list = read("src/app/api/domains/route.ts");
  const item = read("src/app/api/domains/[id]/route.ts");
  const proxy = read("src/app/api/domains/proxy/route.ts");

  it("declares node runtime and dynamic rendering, like every other API route", () => {
    for (const file of [list, item, proxy]) {
      assert.match(file, /export const runtime = "nodejs"/);
      assert.match(file, /export const dynamic = "force-dynamic"/);
    }
  });

  it("answers an unauthenticated request with JSON, never HTML", () => {
    for (const file of [list, item, proxy]) {
      assert.match(file, /notAuthenticated\(\)/, "the route must reject an unauthenticated caller");
    }
  });

  it("reports a rejected hostname as a 400 with a machine-readable code", () => {
    for (const file of [list, item]) {
      assert.match(file, /code: "invalid_hostname"/);
      assert.match(file, /status: 400/);
    }
  });

  it("never returns a 200 with a bare body where an error is expected", () => {
    for (const file of [list, item, proxy]) {
      assert.match(file, /NextResponse\.json\(\{ code:/, "failures must carry a code");
    }
  });

  it("takes the server for a reconcile from the authenticated user, not the request body", () => {
    // A serverId is read from the body, but ownership is resolved before anything is done with it.
    assert.match(proxy, /server\.findFirst\(\{ where: \{ id: body\.serverId, userId: identity\.userId \}/);
    assert.match(proxy, /server_not_found/);
  });

  it("only ever accepts the documented actions", () => {
    assert.match(item, /action === "enable"/);
    assert.match(item, /action === "disable"/);
    assert.match(item, /Action must be enable or disable/);
  });
});
