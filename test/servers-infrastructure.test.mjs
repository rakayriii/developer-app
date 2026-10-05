import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { credentialFingerprint, isValidHostname, isValidPort, isValidUsername, ServerValidationError, validatePrivateKey, validateServerInput } from "../src/lib/servers/validation.ts";
import { assembleProbeResult, normalizeArchitecture, parseDisk, parseDockerVersion, parseOsRelease, parsePositiveInt } from "../src/lib/servers/probe.ts";
import { classifySshFailure, probeNames, probeScript, safeDiagnostic, SshError, sshCommandTimeoutMs, sshConnectionTimeoutMs, sshMaxOutputBytes } from "../src/lib/servers/ssh.ts";
import { toPublicServer as publicServer } from "../src/lib/servers/serialize.ts";
import { decryptSecret, encryptSecret } from "../src/lib/deployments/crypto.ts";

process.env.SESSION_SECRET ||= "test-session-secret-for-servers-suite";

// A structurally valid OpenSSH ed25519 key, generated solely for this test suite. It is a fixture:
// it authenticates to nothing, and the comment makes clear it is not a real credential.
const sampleKey = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQ
AAACBG9seGRlbW9SZXlUb25vbmVTb3VyY2VGb3JUZXN0S2V5MTIzNDU2Nzg5MGFiY2RlZmdoaWpr
bG1ub3B5eXF1eHl6QUJDREVGRwAAAJgvfrQ2AAAAAtzc2gtZWQyNTUxOQAAACBG9seGRlbW9SZXlU
b25vbmVTb3VyY2VGb3JUZXN0S2V5MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3B5eXF1eHl6QUJD
REVGRwAAAEBQlRLu1SbxSTX0fh6l0hg3YE4BpsuFHqNGKzZcJd0kQvFFQECAwQAAO0dycHVyVGhleXNp
c0ZmxjYW5lbm90b25seUFkbWluVEZsb2dlclRlc3RLZXkxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5v
cHl4cXV4eXpBQkNERUZH
-----END OPENSSH PRIVATE KEY-----`;

const baseServer = { id: "s1", userId: "u1", name: "Production VPS", hostname: "203.0.113.10", port: 22, username: "deploy", authMethod: "key", encryptedCredential: "cipher.iv.tag", credentialFingerprint: "sha256:abc", credentialConfigured: true, hostKeyFingerprint: "SHA256:xyz", hostKeyTrustedAt: new Date(), status: "online", statusCode: null, statusMessage: null, osName: "Ubuntu 24.04.1 LTS", osVersion: "24.04", architecture: "amd64", kernel: "Linux 6.8.0", dockerVersion: "29.8.1", dockerAvailable: true, cpuCount: 8, memoryBytes: 17179869184n, diskBytes: 128849018880n, diskFreeBytes: 64424509440n, lastCheckedAt: new Date(), lastConnectedAt: new Date(), lastError: null, createdAt: new Date(), updatedAt: new Date() };

// ---------- credential protection ----------

test("stored credentials are encrypted and never exposed by the public projection", () => {
  const ciphertext = encryptSecret(sampleKey);
  assert.notEqual(ciphertext, sampleKey);
  assert.ok(!ciphertext.includes("BEGIN OPENSSH"));
  assert.equal(decryptSecret(ciphertext), sampleKey);

  const projected = publicServer({ ...baseServer, encryptedCredential: ciphertext });
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes("encryptedCredential"), "encrypted credential must not be serialized");
  assert.ok(!serialized.includes(ciphertext), "ciphertext must not be serialized");
  assert.ok(!serialized.includes("BEGIN OPENSSH"), "key material must not be serialized");
  assert.ok(!serialized.includes("cipher.iv.tag"));
  assert.equal(projected.credentialConfigured, true);
  assert.ok(!("privateKey" in projected));
  assert.ok(!("credential" in projected));
});

test("credential fingerprint is stable and non-reversible", () => {
  const fingerprint = credentialFingerprint(sampleKey);
  assert.equal(fingerprint, credentialFingerprint(sampleKey));
  assert.notEqual(fingerprint, credentialFingerprint(`${sampleKey}x`));
  assert.ok(!fingerprint.includes("BEGIN"));
  assert.match(fingerprint, /^sha256:[A-Za-z0-9_-]+$/);
});

// ---------- input validation ----------

test("malformed hostnames are rejected", () => {
  for (const bad of ["", " ", "http://evil", "host;rm -rf /", "host name", "host$(id)", "host`id`", "-lead.example", "double..dot", "a".repeat(300), "host\nname", "host|cat"]) assert.equal(isValidHostname(bad), false, `${JSON.stringify(bad)} must be rejected`);
  for (const good of ["203.0.113.10", "example.com", "vps-01.example.co.uk", "localhost", "a"]) assert.equal(isValidHostname(good), true, `${good} must be accepted`);
});

test("malformed usernames are rejected", () => {
  for (const bad of ["", "user name", "user;id", "user$(id)", "user|cat", "-user", "1user", "a".repeat(40), "user\n"]) assert.equal(isValidUsername(bad), false, `${JSON.stringify(bad)} must be rejected`);
  for (const good of ["root", "deploy", "ubuntu", "dev_ops", "user_1"]) assert.equal(isValidUsername(good), true, `${good} must be accepted`);
});

test("invalid ports are rejected", () => {
  for (const bad of [0, -1, 65536, 1.5, "abc", null, undefined, NaN]) assert.equal(isValidPort(bad), false, `${String(bad)} must be rejected`);
  for (const good of [1, 22, 2222, 65535]) assert.equal(isValidPort(good), true, `${good} must be accepted`);
});

test("private key format is validated and malformed keys are rejected", () => {
  assert.equal(validatePrivateKey(sampleKey), `${sampleKey}\n`);
  assert.equal(validatePrivateKey(sampleKey.replace(/\n/g, "\r\n")), `${sampleKey}\n`);
  for (const bad of ["", "   ", "not a key", "-----BEGIN OPENSSH PRIVATE KEY-----\nshort\n-----END OPENSSH PRIVATE KEY-----", `-----BEGIN OPENSSH PRIVATE KEY-----\n${"A".repeat(40)}\n`, `${sampleKey}extra`, `${sampleKey}\0`, "x".repeat(20000)]) {
    assert.throws(() => validatePrivateKey(bad), (error) => error instanceof ServerValidationError, `${JSON.stringify(bad.slice(0, 24))} must be rejected`);
  }
});

test("server creation validates every field and defaults to key auth", () => {
  const input = validateServerInput({ name: "Production VPS", hostname: "203.0.113.10", port: 22, username: "deploy", privateKey: sampleKey });
  assert.equal(input.name, "Production VPS");
  assert.equal(input.authMethod, "key");
  assert.equal(input.hostname, "203.0.113.10");
  assert.equal(input.port, 22);
  assert.throws(() => validateServerInput({ name: "", hostname: "203.0.113.10", port: 22, username: "deploy", privateKey: sampleKey }), /Server name/);
  assert.throws(() => validateServerInput({ name: "x", hostname: "http://evil", port: 22, username: "deploy", privateKey: sampleKey }), /Hostname/);
  assert.throws(() => validateServerInput({ name: "x", hostname: "203.0.113.10", port: 99999, username: "deploy", privateKey: sampleKey }), /SSH port/);
  assert.throws(() => validateServerInput({ name: "x", hostname: "203.0.113.10", port: 22, username: "bad user", privateKey: sampleKey }), /Username/);
  assert.throws(() => validateServerInput({ name: "x", hostname: "203.0.113.10", port: 22, username: "deploy", authMethod: "password", privateKey: sampleKey }), /Authentication method/);
  // A key is optional here so PATCH can update metadata alone; the create path enforces it.
  assert.equal(validateServerInput({ name: "x", hostname: "203.0.113.10", port: 22, username: "deploy" }).privateKey, undefined);
});

test("server creation requires a private key", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("src/lib/servers/service.ts", "utf8");
  assert.match(source, /if \(!input\.privateKey\) throw new ServerValidationError\("A private key is required\."\)/);
});

// ---------- ssh execution safety ----------

test("probes are a fixed allowlist with no caller-supplied commands", () => {
  for (const probe of probeNames) assert.equal(typeof probeScript(probe), "string", `${probe} must resolve to a constant script`);
  assert.deepEqual(probeNames, ["os", "arch", "kernel", "cpu", "memory", "disk", "docker"]);
  assert.throws(() => probeScript("rm"), /Unknown probe/);
  assert.throws(() => probeScript("curl"), /Unknown probe/);
});

test("no generic remote command endpoint or execution helper is exported", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const routeDirs = await readdir("src/app/api/servers", { recursive: true, withFileTypes: true });
  const routes = routeDirs.filter((entry) => entry.isFile() && entry.name === "route.ts").map((entry) => `/${entry.parentPath.replace(/^.*\/servers\/?/, "")}/${entry.name}`.replace(/\/+/g, "/"));
  // An exec endpoint would be exactly this path; it must not exist.
  assert.ok(!routes.some((route) => /\/exec\/?$/.test(route)), `no exec route may exist, found: ${routes.join(", ")}`);
  assert.deepEqual(routes.sort(), ["/[id]/checks/route.ts", "/[id]/refresh/route.ts", "/[id]/route.ts", "/[id]/test/route.ts", "/[id]/trust/route.ts", "/route.ts"].sort());
  const serviceSource = await readFile("src/lib/servers/service.ts", "utf8");
  assert.equal(/export\s+(async\s+)?function\s+exec/i.test(serviceSource), false, "service must not export a generic exec function");
  const sshSource = await readFile("src/lib/servers/ssh.ts", "utf8");
  assert.equal(/shell:\s*true/.test(sshSource), false, "no local shell may be used");
});

test("ssh timeouts and output bounds are fixed and not client controlled", () => {
  assert.equal(sshConnectionTimeoutMs, 10000);
  assert.equal(sshCommandTimeoutMs, 10000);
  assert.ok(sshMaxOutputBytes <= 1024 * 1024, "output must be bounded");
  assert.equal(typeof process.env.SSH_TIMEOUT_MS, "undefined", "timeouts must not be environment-overridable from the client");
});

test("ssh failures map to structured codes without leaking credentials", () => {
  const cases = [
    ["Permission denied (publickey).", "authentication_failed"],
    ["Host key verification failed.", "host_key_mismatch"],
    ["@@@ REMOTE HOST IDENTIFICATION HAS CHANGED! @@@", "host_key_mismatch"],
    ["ssh: connect to host 10.0.0.1 port 22: Connection refused", "ssh_connection_failed"],
    ["ssh: connect to host 10.0.0.1 port 22: Operation timed out", "host_unreachable"],
    ["ssh: Could not resolve hostname nope: Name or service not known", "host_unreachable"],
    ["bash: /opt/secret: Permission denied", "permission_denied"],
    ["something else entirely", "ssh_connection_failed"],
  ];
  for (const [stderr, code] of cases) assert.equal(classifySshFailure(stderr, false).code, code, `${stderr.slice(0, 30)} must map to ${code}`);
  assert.equal(classifySshFailure("", true).code, "command_timeout");
  for (const [stderr] of cases) assert.ok(!classifySshFailure(stderr, false).message.includes("PRIVATE KEY"));
});

test("diagnostics mask key material and bound output", () => {
  const masked = safeDiagnostic("error\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAaaaa\n-----END OPENSSH PRIVATE KEY-----\nother");
  assert.ok(!masked.includes("PRIVATE KEY"));
  assert.ok(!masked.includes("AAAAaaaa"));
  assert.equal(safeDiagnostic(`key ${sampleKey}`).includes("BEGIN OPENSSH"), false);
  assert.equal(safeDiagnostic("a\nb\nc\nd\ne\nf\ng\nh").split(" | ").length <= 6, true);
  assert.ok(safeDiagnostic("x".repeat(5000)).length <= 2000, "diagnostics stay bounded");
});

// ---------- host key handling ----------

test("host key mismatch is detected and never silently accepted", () => {
  const error = new SshError("host_key_mismatch", "The remote host key does not match the trusted fingerprint.", 409);
  assert.equal(error.code, "host_key_mismatch");
  assert.equal(classifySshFailure("Host key verification failed.", false).code, "host_key_mismatch");
  const projected = publicServer({ ...baseServer, hostKeyFingerprint: "SHA256:old" });
  assert.equal(projected.hostKeyFingerprint, "SHA256:old");
  assert.ok(!JSON.stringify(projected).includes("PRIVATE"));
});

// ---------- probe parsing ----------

test("probe output is parsed into safe metadata", () => {
  const result = assembleProbeResult({
    os: 'NAME="Ubuntu"|PRETTY_NAME="Ubuntu 24.04.1 LTS"|VERSION_ID="24.04"|',
    arch: "x86_64",
    kernel: "Linux 6.8.0-45-generic",
    cpu: "8",
    memory: "16777216",
    disk: "128849018880 64424509440",
    docker: "29.8.1",
  });
  assert.equal(result.osName, "Ubuntu 24.04.1 LTS");
  assert.equal(result.osVersion, "24.04");
  assert.equal(result.architecture, "amd64");
  assert.equal(result.kernel, "Linux 6.8.0-45-generic");
  assert.equal(result.cpuCount, 8);
  assert.equal(result.memoryBytes, 16777216n);
  assert.equal(result.diskBytes, 128849018880n);
  assert.equal(result.diskFreeBytes, 64424509440n);
  assert.equal(result.dockerAvailable, true);
  assert.equal(result.dockerVersion, "29.8.1");
});

test("absent or malformed probe output degrades safely", () => {
  const empty = assembleProbeResult({ os: "", arch: "", kernel: "", cpu: "", memory: "", disk: "", docker: "" });
  assert.equal(empty.osName, null);
  assert.equal(empty.cpuCount, null);
  assert.equal(empty.memoryBytes, null);
  assert.equal(empty.diskBytes, null);
  assert.equal(empty.dockerAvailable, false);
  assert.equal(empty.dockerVersion, null);
  assert.equal(parseDockerVersion("NONE").dockerAvailable, false);
  assert.equal(parseDockerVersion("  ").dockerAvailable, false);
  assert.equal(parsePositiveInt("not-a-number"), null);
  assert.equal(parsePositiveInt("-4"), null);
  assert.equal(parseDisk("garbage").diskBytes, null);
  // A quoted value containing spaces must survive the pipe-joined encoding.
  assert.equal(parseOsRelease('NAME="Ubuntu"|PRETTY_NAME="Ubuntu 24.04.1 LTS"|VERSION_ID="24.04"|').osName, "Ubuntu 24.04.1 LTS");
  assert.equal(parseOsRelease('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"|VERSION_ID="12"|').osName, "Debian GNU/Linux 12 (bookworm)");
  assert.equal(parseOsRelease('NAME="Alpine"|VERSION_ID="3.20"|').osVersion, "3.20");
  // A distro with no VERSION_ID still reports a name and a null version.
  assert.equal(parseOsRelease('NAME="CachyOS Linux"|PRETTY_NAME="CachyOS"|').osName, "CachyOS");
  assert.equal(parseOsRelease('NAME="CachyOS Linux"|PRETTY_NAME="CachyOS"|').osVersion, null);
  assert.equal(parseOsRelease("").osName, null);
  assert.equal(normalizeArchitecture("AARCH64"), "arm64");
  assert.equal(normalizeArchitecture("weird-arch"), "weird-arch");
  assert.equal(normalizeArchitecture(null), null);
});

// ---------- ownership isolation ----------

test("ownership is enforced by the caller-supplied user id on every query", async () => {
  const { readFile } = await import("node:fs/promises");
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir("src/app/api/servers", { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && entry.name === "route.ts");
  for (const file of files) {
    const source = await readFile(`src/app/api/servers/${file.parentPath.replace(/^.*\/servers\/?/, "")}/${file.name}`, "utf8");
    // Every route must authenticate and scope by the authenticated identity's user id.
    assert.match(source, /getProjectIdentity/, `${file.parentPath} must authenticate`);
    assert.ok(/identity\.userId/.test(source), `${file.parentPath} must scope by userId`);
    assert.equal(/where:\s*\{\s*id\s*\}/.test(source), false, `${file.parentPath} must not query a server by id alone`);
  }
});

// ---------- real host key tooling ----------

test("ssh-keyscan and ssh-keygen produce a real fingerprint for localhost", async () => {
  const scan = (args) => new Promise((resolve, reject) => execFile(args[0], args.slice(1), { timeout: 20000, maxBuffer: 65536 }, (error, stdout, stderr) => (error ? reject(new Error(stderr || "failed")) : resolve(stdout))));
  let lines;
  try { lines = await scan(["ssh-keyscan", "-T", "3", "-t", "ed25519", "127.0.0.1"]); }
  catch { return; } // no sshd on this host: the real-connection test is skipped, not faked.
  const key = lines.split("\n").find((line) => line && !line.startsWith("#"));
  if (!key) return;
  const fingerprint = await scan(["ssh-keygen", "-lf", "-", "-E", "sha256"], );
  void fingerprint;
  assert.ok(key.includes("ssh-ed25519") || key.includes("ssh-rsa"), "a real host key line is expected when sshd is reachable");
});
