import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getProjectIdentity } from "@/lib/projects/auth";

export const runtime = "nodejs";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; containerId: string }> }) {
  const identity = await getProjectIdentity();
  if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
  const values = await params;
  const project = await prisma.project.findFirst({ where: { id: values.id, userId: identity.userId }, select: { id: true } });
  if (!project) return NextResponse.json({ code: "not_found", message: "Project not found." }, { status: 404 });
  await prisma.projectDockerContainer.deleteMany({ where: { projectId: values.id, containerId: values.containerId } });
  return NextResponse.json({ ok: true });
}
