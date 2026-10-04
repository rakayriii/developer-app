export type RuntimeVariableSpec = { secret: boolean; description: string };

export const runtimeVariableAllowlist: Readonly<Record<string, RuntimeVariableSpec>> = Object.freeze({
  APP_KEY: { secret: true, description: "Application encryption key (base64:...). Injected at container start only." },
  APP_ENV: { secret: false, description: "Application environment name." },
  APP_DEBUG: { secret: false, description: "Debug mode flag." },
  APP_URL: { secret: false, description: "Public base URL of the deployment." },
  DB_CONNECTION: { secret: false, description: "Database driver, for example sqlite or mysql." },
  DB_HOST: { secret: false, description: "Database host." },
  DB_PORT: { secret: false, description: "Database port." },
  DB_DATABASE: { secret: false, description: "Database name or file path." },
  DB_USERNAME: { secret: false, description: "Database user." },
  DB_PASSWORD: { secret: true, description: "Database password." },
  SESSION_DRIVER: { secret: false, description: "Session backend, for example file or database." },
  CACHE_STORE: { secret: false, description: "Cache backend, for example file or database." },
  QUEUE_CONNECTION: { secret: false, description: "Queue connection, for example sync or database." },
});

export const runtimeVariableNames = Object.freeze(Object.keys(runtimeVariableAllowlist));

export const serverControlledVariableNames = Object.freeze(["PORT"]);

const plainValuePattern = /^[A-Za-z0-9._:/@+=,-]*$/;

export class RuntimeVariableError extends Error {
  code = "invalid_runtime_variable";
  status = 400;
}

export function isRuntimeVariableName(name: unknown): name is string {
  return typeof name === "string" && Object.hasOwn(runtimeVariableAllowlist, name);
}

export function isSecretRuntimeVariable(name: string) {
  return runtimeVariableAllowlist[name]?.secret === true;
}

export function validateRuntimeVariable(name: unknown, value: unknown) {
  if (typeof name !== "string" || !name.trim()) throw new RuntimeVariableError("A runtime variable name is required.");
  const key = name.trim();
  if (serverControlledVariableNames.includes(key)) throw new RuntimeVariableError(`${key} is controlled by the deployment engine and cannot be set.`);
  if (!isRuntimeVariableName(key)) throw new RuntimeVariableError(`${key} is not an allowed runtime variable.`);
  if (typeof value !== "string") throw new RuntimeVariableError(`${key} must be a string value.`);
  const secret = isSecretRuntimeVariable(key);
  if (value.includes("\0")) throw new RuntimeVariableError(`${key} contains an invalid character.`);
  if (secret) {
    if (value.length > 1024) throw new RuntimeVariableError(`${key} exceeds the maximum secret length.`);
    if (/[\x00-\x1f\x7f]/.test(value)) throw new RuntimeVariableError(`${key} contains an invalid character.`);
  } else {
    if (value.length > 512) throw new RuntimeVariableError(`${key} exceeds the maximum length.`);
    if (!plainValuePattern.test(value)) throw new RuntimeVariableError(`${key} contains an unsupported character.`);
  }
  return { name: key, value, secret };
}

export type RuntimeVariableInput = { name: string; secret: boolean; value: string };

export function parseRuntimeVariableList(body: Record<string, unknown>): RuntimeVariableInput[] {
  const raw = Array.isArray(body.variables) ? body.variables : body.variables === undefined ? [] : null;
  if (!raw) throw new RuntimeVariableError("Runtime variables must be provided as a list.");
  return raw.map((entry) => {
    if (!entry || typeof entry !== "object") throw new RuntimeVariableError("Each runtime variable must be an object.");
    const { name, value } = entry as { name?: unknown; value?: unknown };
    const parsed = validateRuntimeVariable(name, value);
    return { name: parsed.name, secret: parsed.secret, value: parsed.value };
  });
}

export function redactSecrets(text: string, secretValues: readonly string[]) {
  let output = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 4) output = output.split(secret).join("[redacted]");
  }
  return output;
}

export function missingRuntimeVariables(names: readonly string[]) {
  return runtimeVariableNames.filter((name) => !names.includes(name));
}
