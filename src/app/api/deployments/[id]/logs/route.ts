import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deploymentIdentity, forbidden, notAuthenticated, deploymentError } from "@/lib/deployments/api";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const identity = await deploymentIdentity(); if (!identity) return notAuthenticated(); const { id } = await context.params; const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } }, select: { id: true } }); if (!deployment) return forbidden(); return NextResponse.json(await prisma.deploymentLog.findMany({ where: { deploymentId: id }, orderBy: { timestamp: "asc" }, take: 1000 })); } catch (error) { return deploymentError(error); } }
