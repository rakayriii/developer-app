import { GitValidationError, resolveRepository } from "../git/validation.ts";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const environmentTypes = ["development", "staging", "production"] as const;
export type EnvironmentType = (typeof environmentTypes)[number];
const configuredHealthTimeout = Number(process.env.DEPLOYMENT_HEALTH_TIMEOUT_MS || "5000");
export const defaultEnvironment = { containerPort: 3000, healthPath: "/", healthTimeoutMs: Number.isInteger(configuredHealthTimeout) && configuredHealthTimeout >= 500 && configuredHealthTimeout <= 30000 ? configuredHealthTimeout : 5000, healthRetries: 5, cpuLimit: process.env.DEPLOYMENT_DEFAULT_CPU_LIMIT || "1.0", memoryLimit: process.env.DEPLOYMENT_DEFAULT_MEMORY_LIMIT || "512m", restartPolicy: "unless-stopped" };
export function validateEnvironmentInput(value: Record<string, unknown>) {
  const type = value.type === undefined ? "development" : value.type; if (typeof type !== "string" || !environmentTypes.includes(type as EnvironmentType)) throw new Error("Environment type is invalid.");
  const name = typeof value.name === "string" && value.name.trim() ? value.name.trim().slice(0, 80) : type[0].toUpperCase() + type.slice(1);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50); if (!slug) throw new Error("Environment name is invalid.");
  const integer = (input: unknown, fallback: number, min: number, max: number) => { const result = input === undefined ? fallback : Number(input); if (!Number.isInteger(result) || result < min || result > max) throw new Error("Environment numeric configuration is invalid."); return result; };
  const containerPort = integer(value.containerPort, defaultEnvironment.containerPort, 1, 65535); const hostPort = integer(value.hostPort, 0, 1, 65535); if (!hostPort) throw new Error("A host port is required.");
  const healthPath = value.healthPath === undefined ? "/" : value.healthPath; if (typeof healthPath !== "string" || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(healthPath) || healthPath.length > 200) throw new Error("Health path is invalid.");
  const cpuLimit = value.cpuLimit === undefined ? defaultEnvironment.cpuLimit : value.cpuLimit; const memoryLimit = value.memoryLimit === undefined ? defaultEnvironment.memoryLimit : value.memoryLimit; if (typeof cpuLimit !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(cpuLimit) || Number(cpuLimit) <= 0 || Number(cpuLimit) > 8) throw new Error("CPU limit is invalid."); if (typeof memoryLimit !== "string" || !/^\d+(?:m|g)$/i.test(memoryLimit)) throw new Error("Memory limit is invalid.");
  return { name, slug, type: type as EnvironmentType, containerPort, hostPort, healthPath, healthTimeoutMs: integer(value.healthTimeoutMs, defaultEnvironment.healthTimeoutMs, 500, 30000), healthRetries: integer(value.healthRetries, defaultEnvironment.healthRetries, 1, 10), cpuLimit, memoryLimit, restartPolicy: "unless-stopped", runMigrations: value.runMigrations === undefined ? false : Boolean(value.runMigrations) };
}

function contained(root: string, candidate: string) { const relative = path.relative(root, candidate); return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)); }
export async function deploymentRepositoryReference(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new GitValidationError("invalid_repository", "Repository path is required.", 400);
  const configuredRoot = process.env.GIT_WORKSPACE_ROOT;
  if (!configuredRoot) throw new GitValidationError("workspace_not_configured", "GIT_WORKSPACE_ROOT is not configured.", 503);
  const root = await realpath(configuredRoot).catch(() => { throw new GitValidationError("workspace_not_found", "The configured Git workspace does not exist.", 404); });
  const requested = value.trim();
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const canonical = await realpath(candidate).catch(() => { throw new GitValidationError("repository_not_found", "Repository was not found.", 404); });
  if (!contained(root, canonical)) throw new GitValidationError("repository_forbidden", "Repository is outside the configured Git workspace.", 403);
  const repositoryPath = path.relative(root, canonical) || ".";
  return { repositoryPath, repositoryRoot: (await resolveRepository(repositoryPath)).repositoryRoot };
}
export async function deploymentRepository(pathValue: string | null | undefined) { if (!pathValue) throw new GitValidationError("repository_not_configured", "Project has no local repository configured.", 409); return deploymentRepositoryReference(pathValue); }
