// Lets plain Node import the application's own modules the way Next.js does: the "@/" alias and
// extensionless relative imports. Verification scripts therefore exercise the real service code
// instead of a re-implementation of it.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const withExtension = (base) => {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
};

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(pathToFileURL(withExtension(path.join(projectRoot, "src", specifier.slice(2)))).href, context);
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const absolute = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    const direct = withExtension(absolute);
    if (existsSync(direct)) return nextResolve(pathToFileURL(direct).href, context);
  }
  return nextResolve(specifier, context);
}
