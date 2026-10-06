import { RemoteDeploymentError } from "./errors.ts";

/**
 * Server-generated from the deployment id and constrained to the strict remote-path character class,
 * so the file location can never be influenced by a request.
 */
export const remoteEnvironmentFilePath = (deploymentId: string) => `/tmp/developer-os-env-${deploymentId.replace(/[^a-zA-Z0-9]/g, "")}`;

/**
 * Renders the Docker env file used for remote container creation.
 *
 * Docker's env-file parser splits on the first `=` and otherwise takes the value verbatim: it does not
 * strip quotes and does not process escapes. Verified against Docker 27.5.1, where `KEY="80"` reaches the
 * container as the literal value `"80"`. Values are therefore emitted unquoted, and the only characters
 * that cannot be represented - a newline, a carriage return, and NUL, each of which would split the file
 * into a different set of assignments - are rejected rather than silently mis-encoded.
 *
 * `validateRuntimeVariable` already excludes newlines and control characters for both plain and secret
 * values; this is the second, independent check at the point where the file is actually written.
 */
export function renderEnvironmentFile(variables: Record<string, string>) {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new RemoteDeploymentError("invalid_runtime_variable", `Runtime variable ${key} cannot be written to an env file.`, 400);
    if (/[\n\r\0]/.test(value)) throw new RemoteDeploymentError("invalid_runtime_variable", `Runtime variable ${key} contains a character that cannot be represented in an env file.`, 400);
    lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}
