import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getProjectIdentity } from "@/lib/projects/auth";
import { DockerError, getDockerContainers } from "@/lib/docker/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const unauthenticated = () => NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
const projectMissing = () => NextResponse.json({ code: "not_found", message: "Project not found." }, { status: 404 });
const dockerError = (error: unknown) => { const value = error instanceof DockerError ? error : new DockerError("unavailable", "Docker daemon is unavailable.", 503); return NextResponse.json({ code: value.code, message: value.message }, { status: value.status }); };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return unauthenticated();
    const project = await prisma.project.findFirst({ where: { id: (await params).id, userId: identity.userId }, include: { dockerAssociations: true } });
    if (!project) return projectMissing();
    const containers = await getDockerContainers();
    const byId = new Map(containers.map((container) => [container.id, container]));
    return NextResponse.json({ items: project.dockerAssociations.map((association) => ({ containerId: association.containerId, container: byId.get(association.containerId) || null })) });
  } catch (error) { return error instanceof DockerError ? dockerError(error) : NextResponse.json({ code: "project_error", message: "Project Docker data could not be loaded." }, { status: 500 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return unauthenticated();
    const projectId = (await params).id;
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: identity.userId }, select: { id: true } });
    if (!project) return projectMissing();
    const body = await request.json().catch(() => null) as { containerId?: unknown } | null;
    if (!body || typeof body.containerId !== "string" || !/^[a-zA-Z0-9_-]{12,128}$/.test(body.containerId)) return NextResponse.json({ code: "validation_error", message: "A valid Docker container ID is required." }, { status: 400 });
    const containerId = body.containerId;
    const containers = await getDockerContainers();
    const container = containers.find((item) => item.id === containerId || item.id.startsWith(containerId));
    if (!container) return NextResponse.json({ code: "container_not_found", message: "That container is not available from the Docker daemon." }, { status: 404 });
    const association = await prisma.projectDockerContainer.upsert({ where: { projectId_containerId: { projectId, containerId: container.id } }, update: {}, create: { projectId, containerId: container.id } });
    return NextResponse.json({ containerId: association.containerId }, { status: 201 });
  } catch (error) { return error instanceof DockerError ? dockerError(error) : NextResponse.json({ code: "project_error", message: "The Docker container could not be connected." }, { status: 500 }); }
}
