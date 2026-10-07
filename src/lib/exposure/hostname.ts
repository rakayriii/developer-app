// Hostname validation for an exposed application.
//
// A hostname ends up in two places that both interpret it as more than text: a Caddy configuration on a
// remote host, and a DNS lookup. Everything that could change the meaning of either is rejected outright
// rather than stripped, because silently rewriting a hostname would route traffic somewhere the operator
// did not name.
//
// localhost and bare IP addresses are refused unless the operator opts in, so the default path can only
// ever produce a name that could legitimately be resolved in public DNS.

export class HostnameError extends Error {
  code = "invalid_hostname";
  status = 400;
}

const fail = (message: string): never => { throw new HostnameError(message); };

// Characters that are structural in a URL, a DNS name, a shell, or a Caddyfile directive. The two that
// matter most are the Caddy address brackets and the quote, because either would end a directive early.
const forbidden = /[\\/@:?#\s"'`<>{}()[\]|&$!*;,~^%+=]/;
const forbiddenOnce = (value: string) => value.split("").some((character) => forbidden.test(character));

/** A single DNS label: 1-63 characters, alphanumeric with interior hyphens only. */
function isValidLabel(label: string) {
  if (label.length < 1 || label.length > 63) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return false;
  return true;
}

export function isIpv4(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isIpv6(value: string) {
  return /^[0-9a-f:]+$/i.test(value) && value.includes(":") && /^[0-9a-f:.]+$/i.test(value);
}

export type HostnameOptions = {
  /** Permit `localhost` and any `*.localhost` name. Intended for development only. */
  allowLocal?: boolean;
  /** Permit a bare IPv4 or IPv6 literal as the hostname. Intended for development only. */
  allowIp?: boolean;
};

export type NormalizedHostname = {
  hostname: string;
  /** True when the name is only routable on the machine that created it. */
  local: boolean;
  /** True when the name is a bare address rather than a DNS name. */
  address: boolean;
};

/**
 * Validates and normalizes a hostname.
 *
 * Normalization is limited to case and a single trailing root dot: both are DNS-equivalent spellings of
 * the same name, so accepting them changes nothing about where traffic goes. Nothing else is rewritten.
 */
export function normalizeHostname(input: unknown, options: HostnameOptions = {}): NormalizedHostname {
  // Leading and trailing whitespace is an editing artefact rather than part of a name, so it is trimmed
  // once here. Whitespace *inside* a name is rejected below as a structural character.
  const raw = typeof input === "string" ? input.trim() : fail("A hostname is required.");
  if (!raw) fail("A hostname is required.");

  // An IPv6 literal is recognised before the structural-character check, because a colon is legal inside
  // an address and is also the marker for a port in a hostname. Checking the address first keeps the
  // message about the address rather than about a "port".
  const address = /^\[[0-9a-f:.]+\]$/i.test(raw) ? raw.slice(1, -1) : raw;
  if (address.includes(":") && isIpv6(address)) {
    if (!options.allowIp) fail("A bare IP address requires IP hostnames to be enabled.");
    return { hostname: address.toLowerCase(), local: false, address: true };
  }

  if (raw.includes("://")) fail("A hostname must not include a protocol.");
  if (forbiddenOnce(raw)) fail("A hostname must not contain a protocol, path, query, fragment, port, or shell metacharacter.");

  // A single trailing dot is the DNS root and means the same name.
  const hostname = raw.toLowerCase().replace(/\.$/, "");
  if (!hostname) fail("A hostname is required.");
  if (hostname.length > 253) fail("A hostname must be 253 characters or fewer.");
  if (hostname.includes("*")) fail("Wildcard hostnames are not supported.");

  const local = hostname === "localhost" || hostname.endsWith(".localhost");
  if (local) {
    if (!options.allowLocal) fail("A localhost hostname requires local domains to be enabled.");
    return { hostname, local: true, address: false };
  }

  // A colon can no longer reach here: an IPv6 literal was handled above, and everything else containing
  // a colon was refused as a port.
  if (isIpv4(hostname)) {
    if (!options.allowIp) fail("A bare IP address requires IP hostnames to be enabled.");
    return { hostname, local: false, address: true };
  }

  const labels = hostname.split(".");
  if (labels.length < 2) fail("A hostname must be a fully qualified name such as example.com.");
  if (!labels.every(isValidLabel)) fail("A hostname contains an invalid DNS label.");

  return { hostname, local: false, address: false };
}

/** True when the name can never be resolved by anyone but this machine. */
export function isLoopbackName(hostname: string) {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "::1";
}