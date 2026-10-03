import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DeploymentDockerError } from "./docker.ts";

export const dockerfileCandidates = ["Dockerfile", "Dockerfile.production", "Dockerfile.prod", "Dockerfile.vercel"] as const;

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function discoverDockerfile(repositoryRoot: string) {
  const root = await realpath(/* turbopackIgnore: true */ repositoryRoot).catch(() => { throw new DeploymentDockerError("repository_not_found", "The validated repository does not exist.", 404); });
  for (const filename of dockerfileCandidates) {
    const candidate = path.join(/* turbopackIgnore: true */ root, filename);
    const information = await lstat(candidate).catch(() => null);
    if (!information) continue;
    if (!information.isFile() || information.isSymbolicLink()) throw new DeploymentDockerError("dockerfile_invalid", `${filename} must be a regular file inside the repository.`, 409);
    const canonical = await realpath(/* turbopackIgnore: true */ candidate).catch(() => null);
    if (!canonical || !contained(root, canonical) || canonical !== candidate) throw new DeploymentDockerError("dockerfile_forbidden", `${filename} resolves outside the repository.`, 403);
    return { name: filename, path: canonical };
  }
  throw new DeploymentDockerError("dockerfile_missing", "The repository does not contain a supported Dockerfile (Dockerfile, Dockerfile.production, Dockerfile.prod, or Dockerfile.vercel).", 409);
}
