// The five health signals, kept apart.
//
// These are genuinely different measurements and collapsing them is how a healthy application ends up
// marked broken. The one that matters most here: Developer OS health comes from a real HTTP request to the
// application, and Docker's own HEALTHCHECK is reported separately. An image whose HEALTHCHECK probes the
// wrong port will show `unhealthy` in the container's Docker health while the application is serving
// perfectly well, and the application must not be recorded as failing because of it.
//
// The GameVault image is exactly that case: its baked-in HEALTHCHECK probes the FrankenPHP admin port
// (2019), which `php-server` mode does not serve. That is a property of that image and is left alone.

export type HealthSignal = "healthy" | "unhealthy" | "starting" | "none" | "unknown";

export type HealthSignals = {
  /** Docker's own HEALTHCHECK, as reported by the container runtime. Advisory: an image can get this wrong. */
  dockerHealthcheck: HealthSignal;
  /** A real HTTP request this application made to the deployment's health path. Authoritative for serving. */
  applicationHttp: HealthSignal;
  /** Whether the container process is running. Independent of both of the above. */
  containerRunning: boolean;
  /** Whether a domain routed to this deployment answered through the reverse proxy. Null when no domain exists. */
  reverseProxy: HealthSignal | null;
  /** Whether the certificate covering a hostname is present and valid. Null when TLS is not in use. */
  tlsCertificate: HealthSignal | null;
};

/** Normalises whatever the container runtime reported into a known signal. */
export function normalizeDockerHealth(value: string | null | undefined): HealthSignal {
  if (!value) return "unknown";
  const key = value.trim().toLowerCase();
  if (key === "healthy") return "healthy";
  if (key === "unhealthy" || key === "starting") return key;
  // "none" means the image declares no HEALTHCHECK at all, which is not a failure.
  if (key === "" || key === "none") return "none";
  return "unknown";
}

/**
 * The health status the deployment record should carry.
 *
 * Only the application's own HTTP answer decides this. Docker's HEALTHCHECK is deliberately excluded: it
 * is advisory, it belongs to the image, and letting it overwrite a successful application check is how a
 * perfectly good deployment gets reported as broken.
 */
export function healthStatusFor(signals: { applicationHttp: HealthSignal; containerRunning: boolean }): "healthy" | "unhealthy" {
  return signals.applicationHttp === "healthy" && signals.containerRunning ? "healthy" : "unhealthy";
}

/**
 * Whether the two signals disagree, which is worth surfacing rather than hiding.
 *
 * A disagreement means the image's HEALTHCHECK and the application disagree - a real, actionable finding
 * about the image, not about the deployment.
 */
export function healthSignalsDisagree(signals: Pick<HealthSignals, "dockerHealthcheck" | "applicationHttp">) {
  return signals.dockerHealthcheck === "unhealthy" && signals.applicationHttp === "healthy";
}

/** A short, factual summary. Never claims more than was measured. */
export function describeHealthSignals(signals: HealthSignals): string[] {
  const parts = [
    `application HTTP: ${signals.applicationHttp}`,
    `container running: ${signals.containerRunning ? "yes" : "no"}`,
    `image healthcheck: ${signals.dockerHealthcheck === "none" ? "not declared" : signals.dockerHealthcheck}`,
  ];
  if (signals.reverseProxy !== null) parts.push(`reverse proxy: ${signals.reverseProxy}`);
  if (signals.tlsCertificate !== null) parts.push(`TLS certificate: ${signals.tlsCertificate}`);
  if (healthSignalsDisagree(signals)) parts.push("the image's HEALTHCHECK disagrees with the application; the application answer is authoritative");
  return parts;
}