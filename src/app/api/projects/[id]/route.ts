import { NextResponse } from "next/server";
import { ProjectStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getProjectIdentity } from "@/lib/projects/auth";
import { projectError } from "@/lib/projects/errors";
import { projectSlug, publicProject, validGithubAssociation, validProjectName, validProjectStatus } from "@/lib/projects/validation";
import { getRepositoryDetail } from "@/lib/github/repository";
import { resolveRepository } from "@/lib/git/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const invalid = (message: string) => NextResponse.json({ code: "validation_error", message }, { status: 400 });

async function ownedProject(id: string, userId: string) { return prisma.project.findFirst({ where: { id, userId }, include: { dockerAssociations: { select: { containerId: true } } } }); }

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
    const project = await ownedProject((await params).id, identity.userId);
    if (!project) return NextResponse.json({ code: "not_found", message: "Project not found." }, { status: 404 });
    const github = project.githubOwner && project.githubRepo ? await getRepositoryDetail(identity.accessToken, project.githubOwner, project.githubRepo) : null;
    return NextResponse.json({ project: publicProject(project), dockerContainerIds: project.dockerAssociations.map((item) => item.containerId), github });
  } catch (error) { return projectError(error); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
    const id = (await params).id;
    const existing = await prisma.project.findFirst({ where: { id, userId: identity.userId } });
    if (!existing) return NextResponse.json({ code: "not_found", message: "Project not found." }, { status: 404 });
    const body = await request.json().catch(() => null) as { name?: unknown; description?: unknown; status?: unknown; githubOwner?: unknown; githubRepo?: unknown; localRepositoryPath?: unknown } | null;
    if (!body) return invalid("A JSON request body is required.");
    const name = body.name === undefined ? existing.name : body.name;
    if (!validProjectName(name)) return invalid("Project name is required and must be 1 to 80 characters.");
    if (body.description !== undefined && body.description !== null && (typeof body.description !== "string" || body.description.length > 500)) return invalid("Description must be 500 characters or fewer.");
    const status = body.status === undefined ? existing.status : body.status;
    if (!validProjectStatus(status)) return invalid("Status must be active, paused, or archived.");
    const owner = body.githubOwner === undefined ? existing.githubOwner : body.githubOwner;
    const repo = body.githubRepo === undefined ? existing.githubRepo : body.githubRepo;
    if (!validGithubAssociation(owner, repo)) return invalid("GitHub owner and repository must be provided together and use valid names.");
    const slug = projectSlug(name);
    const duplicate = await prisma.project.findFirst({ where: { userId: identity.userId, slug, NOT: { id } } });
    if (duplicate) return NextResponse.json({ code: "duplicate_slug", message: "A project with this name already exists." }, { status: 409 });
    if (owner && repo && (owner !== existing.githubOwner || repo !== existing.githubRepo)) await getRepositoryDetail(identity.accessToken, owner as string, repo as string);
    let localRepositoryPath = existing.localRepositoryPath;
    if (body.localRepositoryPath !== undefined) { if (body.localRepositoryPath === null || body.localRepositoryPath === "") localRepositoryPath = null; else { if (typeof body.localRepositoryPath !== "string") return invalid("Local repository path must be relative to GIT_WORKSPACE_ROOT."); await resolveRepository(body.localRepositoryPath); localRepositoryPath = body.localRepositoryPath.trim(); } }
    const project = await prisma.project.update({ where: { id }, data: { name: name.trim(), slug, description: body.description === undefined ? existing.description : typeof body.description === "string" ? body.description.trim() || null : null, status: status as ProjectStatus, githubOwner: owner as string | null, githubRepo: repo as string | null, localRepositoryPath } });
    return NextResponse.json({ project: publicProject(project) });
  } catch (error) { return projectError(error); }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
    const id = (await params).id;
    const project = await prisma.project.findFirst({ where: { id, userId: identity.userId }, select: { id: true } });
    if (!project) return NextResponse.json({ code: "not_found", message: "Project not found." }, { status: 404 });
    await prisma.project.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) { return projectError(error); }
}
