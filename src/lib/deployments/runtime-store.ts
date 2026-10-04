import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { runtimeVariableAllowlist, runtimeVariableNames, type RuntimeVariableInput } from "./runtime-env";

type StoredVariable = { id: string; name: string; secret: boolean; value: string | null; secretValue: string | null };

async function stored(environmentId: string) {
  return prisma.deploymentEnvironmentVariable.findMany({ where: { environmentId }, orderBy: { name: "asc" } }) as Promise<StoredVariable[]>;
}

export async function resolveRuntimeEnvironment(environmentId: string) {
  const rows = await stored(environmentId);
  const variables: Record<string, string> = {};
  const secretValues: string[] = [];
  const unreadable: string[] = [];
  for (const row of rows) {
    if (row.secret) {
      const value = row.secretValue ? decryptSecret(row.secretValue) : null;
      if (!value) { unreadable.push(row.name); continue; }
      variables[row.name] = value;
      secretValues.push(value);
    } else if (row.value !== null) {
      variables[row.name] = row.value;
    }
  }
  return { variables, secretValues, unreadable };
}

export async function replaceRuntimeVariables(environmentId: string, inputs: readonly RuntimeVariableInput[]) {
  const keep = new Set<string>();
  for (const input of inputs) {
    const existing = await prisma.deploymentEnvironmentVariable.findUnique({ where: { environmentId_name: { environmentId, name: input.name } } });
    const data = input.secret
      ? { secret: true, value: null, secretValue: encryptSecret(input.value), updatedAt: new Date() }
      : { secret: false, value: input.value, secretValue: null, updatedAt: new Date() };
    if (existing) await prisma.deploymentEnvironmentVariable.update({ where: { id: existing.id }, data });
    else await prisma.deploymentEnvironmentVariable.create({ data: { environmentId, name: input.name, ...data } });
    keep.add(input.name);
  }
  for (const row of await stored(environmentId)) if (!keep.has(row.name)) await prisma.deploymentEnvironmentVariable.delete({ where: { id: row.id } });
  return describeRuntimeVariables(environmentId);
}

export async function describeRuntimeVariables(environmentId: string) {
  const configured = new Map((await stored(environmentId)).map((row) => [row.name, row]));
  return runtimeVariableNames.map((name) => {
    const spec = runtimeVariableAllowlist[name];
    const row = configured.get(name);
    const configuredRow = Boolean(row) && (row?.secret ? Boolean(row.secretValue) : row?.value != null);
    return {
      name,
      secret: spec.secret,
      description: spec.description,
      configured: configuredRow,
      // Secret values are write-only: a saved secret is never returned, only its presence.
      value: spec.secret ? null : row?.value ?? null,
    };
  });
}
