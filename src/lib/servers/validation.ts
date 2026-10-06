import { createHash } from "node:crypto";

export const serverAuthMethods = ["key"] as const;
export type ServerAuthMethod = (typeof serverAuthMethods)[number];

export class ServerValidationError extends Error {
  code = "invalid_server";
  status = 400;
}

// Returned when a server is still referenced and therefore cannot be removed. A distinct code lets the
// UI explain the real reason instead of showing a generic validation failure.
export class ServerInUseError extends Error {
  code = "server_in_use";
  status = 409;
}

// Returned when a server id does not exist, or exists but belongs to another user. The two cases are
// deliberately indistinguishable so the API never confirms that another account's server exists.
export class ServerNotFoundError extends Error {
  code = "server_not_found";
  status = 404;
}

export class ServerConflictError extends Error {
  code = "server_conflict";
  status = 409;
}

const hostnamePattern = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const ipv4Pattern = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const usernamePattern = /^[a-z_][a-z0-9_-]{0,31}\$?$/i;

export function isValidHostname(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 253) return false;
  const host = value.trim();
  if (host.includes("\0") || /[\s;|&`$(){}<>\\'"!]/.test(host)) return false;
  if (host.startsWith("-") || host.startsWith(".") || host.includes("..")) return false;
  if (ipv4Pattern.test(host)) return true;
  return hostnamePattern.test(host);
}

export function isValidUsername(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 32) return false;
  if (/[\0\n\r\t]/.test(value)) return false;
  const user = value.trim();
  if (user.includes("\0") || /[\s;|&`$(){}\\<>'"/]/.test(user)) return false;
  return usernamePattern.test(user);
}

export function isValidPort(value: unknown) {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// Accepts only PEM OpenSSH private keys. Anything else is rejected before storage.
export function validatePrivateKey(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ServerValidationError("A private key is required.");
  const key = value.replace(/\r\n/g, "\n");
  if (key.length > 16384) throw new ServerValidationError("Private key is too large.");
  if (key.includes("\0")) throw new ServerValidationError("Private key contains an invalid character.");
  const body = key.trim();
  // A real PEM key wraps its base64 body across many lines, so the body is matched line by line.
  const match = /^-----BEGIN (OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----\n([\s\S]+?)\n-----END (OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----$/.exec(body);
  if (!match) throw new ServerValidationError("Private key must be a PEM-encoded OpenSSH, RSA, EC, or DSA private key.");
  const bodyLines = match[2].split("\n").map((line) => line.trim()).filter(Boolean);
  if (!bodyLines.length || bodyLines.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/.test(line))) throw new ServerValidationError("Private key must be a PEM-encoded OpenSSH, RSA, EC, or DSA private key.");
  const payload = bodyLines.join("");
  if (payload.length < 32) throw new ServerValidationError("Private key is too short to be valid.");
  return `${body}\n`;
}

// A non-reversible fingerprint that identifies the stored key without revealing it.
export function credentialFingerprint(privateKey: string) {
  return `sha256:${createHash("sha256").update(privateKey).digest("base64url").slice(0, 43)}`;
}

export type ServerInput = { name: string; hostname: string; port: number; username: string; authMethod: ServerAuthMethod; privateKey?: string };

export function validateServerInput(body: Record<string, unknown>): ServerInput {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 80) throw new ServerValidationError("Server name is required.");
  if (/[\0\n\r]/.test(name)) throw new ServerValidationError("Server name contains an invalid character.");
  if (!isValidHostname(body.hostname)) throw new ServerValidationError("Hostname is not a valid host name or IPv4 address.");
  if (!isValidPort(body.port)) throw new ServerValidationError("SSH port must be between 1 and 65535.");
  if (!isValidUsername(body.username)) throw new ServerValidationError("Username is not a valid SSH user name.");
  const authMethod = body.authMethod === undefined ? "key" : body.authMethod;
  if (typeof authMethod !== "string" || !serverAuthMethods.includes(authMethod as ServerAuthMethod)) throw new ServerValidationError("Authentication method is not supported.");
  return { name, hostname: (body.hostname as string).trim(), port: Number(body.port), username: (body.username as string).trim(), authMethod: authMethod as ServerAuthMethod, privateKey: typeof body.privateKey === "string" ? validatePrivateKey(body.privateKey) : undefined };
}
