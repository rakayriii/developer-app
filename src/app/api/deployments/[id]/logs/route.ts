import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deploymentIdentity, forbidden, notAuthenticated, deploymentError } from "@/lib/deployments/api";
import { knownLogStages } from "@/lib/deployments/logs";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
const knownStreams = new Set<string>(knownLogStages);

// Returns real persisted DeploymentLog rows for exactly this deployment id, bounded, with
// stage and severity metadata. Secret values were redacted at write time and are never present.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await deploymentIdentity();
    if (!identity) return notAuthenticated();
    const { id } = await context.params;
    const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } }, select: { id: true } });
    if (!deployment) return forbidden();
    const rows = await prisma.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { timestamp: "asc" }, take: 1000 });
    const entries = rows.map((row) => ({ id: row.id, timestamp: row.timestamp, stage: knownStreams.has(row.stream) ? row.stream : "runtime", stream: row.stream, severity: row.stream === "error" ? "error" : "info", message: row.message }));
    return NextResponse.json({ deploymentId: id, entries, count: entries.length });
  } catch (error) { return deploymentError(error); }
}
