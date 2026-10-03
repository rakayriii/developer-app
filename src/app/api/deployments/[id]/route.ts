import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deploymentError, deploymentIdentity, forbidden, notAuthenticated } from "@/lib/deployments/api";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
async function owned(id: string) { const identity = await deploymentIdentity(); if (!identity) return { response: notAuthenticated() }; const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } }, include: { project: { select: { id: true, name: true, slug: true } }, environment: true } }); if (!deployment) return { response: forbidden() }; return { deployment }; }
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { try { const { id } = await context.params; const access = await owned(id); if (access.response) return access.response; return NextResponse.json(access.deployment); } catch (error) { return deploymentError(error); } }
