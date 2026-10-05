import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rollbackDeployment } from "@/lib/deployments/service";
import { deploymentError, deploymentIdentity, forbidden, invalid, notAuthenticated } from "@/lib/deployments/api";
export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export const maxDuration = 600;
// targetDeploymentId selects the known-good image explicitly. It is always re-validated against this environment.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { const identity = await deploymentIdentity(); if (!identity) return notAuthenticated(); const { id } = await context.params; const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } } }); if (!deployment) return forbidden(); const body = await request.json().catch(() => ({})) as { targetDeploymentId?: unknown }; const target = body.targetDeploymentId === undefined ? undefined : body.targetDeploymentId; if (target !== undefined && typeof target !== "string") return invalid("targetDeploymentId must be a string."); return NextResponse.json(await rollbackDeployment(id, target), { status: 201 }); } catch (error) { return deploymentError(error, "deployment_rollback"); } }
