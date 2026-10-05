import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deploymentAppUrl } from "@/lib/deployments/operations";
import { deploymentError, deploymentIdentity, forbidden, notAuthenticated } from "@/lib/deployments/api";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

async function owned(id: string) { const identity = await deploymentIdentity(); if (!identity) return { response: notAuthenticated() }; const deployment = await prisma.deployment.findFirst({ where: { id, project: { userId: identity.userId } }, include: { project: { select: { id: true, name: true, slug: true, localRepositoryPath: true } }, environment: true } }); if (!deployment) return { response: forbidden() }; return { deployment }; }

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await owned(id);
    if (access.response) return access.response;
    const deployment = access.deployment;
    const siblings = await prisma.deployment.findMany({ where: { environmentId: deployment.environmentId, id: { not: deployment.id } }, orderBy: { createdAt: "desc" }, take: 25, select: { id: true, status: true, healthStatus: true, commitSha: true, imageTag: true, dockerfile: true, createdAt: true, startedAt: true, finishedAt: true, rollbackOfId: true, rolledBackFromId: true, errorMessage: true } });
    return NextResponse.json({
      id: deployment.id,
      status: deployment.status,
      healthStatus: deployment.healthStatus,
      lastStage: deployment.lastStage,
      errorMessage: deployment.errorMessage,
      stopReason: deployment.stopReason,
      commitSha: deployment.commitSha,
      branch: deployment.branch,
      imageTag: deployment.imageTag,
      dockerfile: deployment.dockerfile,
      containerId: deployment.containerId,
      containerName: deployment.containerName,
      rollbackOfId: deployment.rollbackOfId,
      rolledBackFromId: deployment.rolledBackFromId,
      startedAt: deployment.startedAt,
      finishedAt: deployment.finishedAt,
      restartedAt: deployment.restartedAt,
      createdAt: deployment.createdAt,
      updatedAt: deployment.updatedAt,
      project: deployment.project,
      environment: deployment.environment,
      healthUrl: `http://127.0.0.1:${deployment.environment.hostPort}${deployment.environment.healthPath}`,
      appUrl: deploymentAppUrl(deployment),
      history: siblings,
    });
  } catch (error) { return deploymentError(error); }
}
