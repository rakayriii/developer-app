import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { restartDeployment } from "@/lib/deployments/service";
import { deploymentError, deploymentIdentity, forbidden, notAuthenticated } from "@/lib/deployments/api";
export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export const maxDuration = 300;
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) { try { const identity = await deploymentIdentity(); if (!identity) return notAuthenticated(); const { id } = await context.params; const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } } }); if (!deployment) return forbidden(); return NextResponse.json(await restartDeployment(id)); } catch (error) { return deploymentError(error, "deployment_restart"); } }
