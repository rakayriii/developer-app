import { isLoopbackName } from "./hostname.ts";

// Caddyfile generation.
//
// This is the only place a validated hostname becomes part of a remote configuration file, and it is a pure
// function so the exact bytes Caddy will receive can be asserted in tests rather than inferred. Every
// substituted value is validated here as well as in the hostname validator, because this file is written
// to a remote host and read by a server that treats its own syntax specially.

export const caddyTlsModes = ["none", "internal_ca", "automatic"] as const;
export type CaddyTlsMode = (typeof caddyTlsModes)[number];

export class CaddyConfigError extends Error {
  code = "invalid_proxy_target";
  status = 400;
}

const fail = (message: string): never => { throw new CaddyConfigError(message); };

export type ProxyRoute = {
  hostname: string;
  /** Loopback port on the proxy host where the deployment container is published. */
  upstreamPort: number;
  tlsEnabled: boolean;
  tlsMode: CaddyTlsMode;
  /** Deployment id, used only for a comment so the file can be read back by a human. */
  deploymentId?: string;
};

export function isCaddyTlsMode(value: unknown): value is CaddyTlsMode {
  return typeof value === "string" && caddyTlsModes.includes(value as CaddyTlsMode);
}

/**
 * Rejects anything Caddy would read as syntax rather than as a name.
 *
 * The hostname validator already refuses these, but this is the last point before the bytes leave the
 * process, so the check is repeated rather than assumed.
 */
export function assertSafeHostname(hostname: string) {
  if (typeof hostname !== "string" || !hostname) fail("A hostname is required.");
  if (hostname.length > 253) fail("A hostname must be 253 characters or fewer.");
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(hostname)) fail("A hostname contains a character that is not valid in a proxy configuration.");
  if (hostname.includes("..")) fail("A hostname contains an empty DNS label.");
  if (hostname.includes("*")) fail("Wildcard hostnames are not supported.");
  return hostname;
}

export function assertUpstreamPort(port: unknown) {
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) fail("An upstream port is required.");
  return Number(port);
}

/**
 * The site address: the host, optionally with an `http://` prefix.
 *
 * `tls internal` is Caddy's local certificate authority, which is its one self-signed mechanism; it
 * terminates TLS but the browser will not trust it unless the client installs Caddy's root. Leaving the
 * address bare is Caddy's automatic mode, which asks Let's Encrypt and therefore needs the host reachable
 * on port 80 with DNS already pointing at it. An explicit `http://` prefix is what actually disables
 * automatic HTTPS rather than merely requesting it.
 */
export function siteAddress(route: ProxyRoute) {
  const hostname = assertSafeHostname(route.hostname);
  // An unrecognised mode must be refused rather than falling through to the automatic branch, which
  // would silently ask Caddy for a publicly trusted certificate.
  if (!isCaddyTlsMode(route.tlsMode)) throw new CaddyConfigError("TLS mode is not supported.");
  if (!route.tlsEnabled || route.tlsMode === "none") return `http://${hostname}`;
  return hostname;
}

/**
 * The directives inside a site block.
 *
 * Only the upstream is emitted. Caddy already sets X-Forwarded-For, X-Forwarded-Proto and X-Forwarded-Host
 * from the real request and preserves the original Host, and it warns when a header_up tries to override
 * them ("Unnecessary header_up X-Forwarded-For"). Overriding X-Forwarded-For with just the immediate peer
 * would also throw away the proxy chain, so the defaults are what we want.
 *
 * `tls internal` is a *directive*, not a block of its own. Emitting it as one produces a Caddyfile Caddy
 * rejects with "server block without any key".
 *
 * The upstream host is the literal `127.0.0.1` and only the port is substituted, so no caller-supplied
 * value can decide which host the proxy reaches.
 */
export function siteDirectives(route: ProxyRoute) {
  const port = assertUpstreamPort(route.upstreamPort);
  const lines: string[] = [];
  if (route.tlsEnabled && route.tlsMode === "internal_ca") lines.push("\ttls internal");
  lines.push(`\treverse_proxy 127.0.0.1:${port}`);
  return lines;
}

/** The complete site block for one route. */
export function siteBlock(route: ProxyRoute) {
  const comment = route.deploymentId ? `${route.hostname} (deployment ${route.deploymentId})` : route.hostname;
  return `${siteAddress(route)} {\n\t# ${comment}\n${siteDirectives(route).join("\n")}\n}`;
}

/**
 * The Caddy global options block.
 *
 * The admin endpoint is bound explicitly to the container's loopback interface. It cannot be switched off,
 * because `caddy reload` is what applies a configuration change without dropping in-flight requests, and
 * reload talks to that endpoint. Loopback-only is the real boundary: only 80 and 443 are published off the
 * container, so nothing on the host, on the network, or on the internet can reach the admin API.
 */
export const caddyAdminAddress = "localhost:2019";

export function globalOptionsBlock() {
  return `{\n\tadmin ${caddyAdminAddress}\n}`;
}

/**
 * The complete Caddyfile for every route on one server.
 *
 * The global block must come first, or Caddy rejects the file with "server block without any key".
 */
export function renderCaddyfile(routes: readonly ProxyRoute[]) {
  if (!routes.length) return `${globalOptionsBlock()}\n`;
  const blocks = routes.map((route) => siteBlock(route));
  return [globalOptionsBlock(), "", ...blocks].join("\n");
}

/** Stable fingerprint of a rendered configuration, so a no-op reload can be skipped. */
export function configHash(contents: string) {
  // A small, dependency-free hash. It only has to detect change, not resist an adversary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** A short, human-readable summary of one route, used in API responses and logs. */
export function describeRoute(route: ProxyRoute) {
  return `${route.hostname} -> 127.0.0.1:${route.upstreamPort} (${route.tlsEnabled && route.tlsMode !== "none" ? route.tlsMode : "plain http"}${isLoopbackName(route.hostname) ? ", local only" : ""})`;
}