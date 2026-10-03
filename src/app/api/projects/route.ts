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

const unauthenticated = () => NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing projects." }, { status: 401 });
const invalid = (message: string) => NextResponse.json({ code: "validation_error", message }, { status: 400 });

export async function GET(request: Request) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return unauthenticated();
    const params = new URL(request.url).searchParams;
    const search = params.get("search")?.trim() || "";
    const status = params.get("status");
    const page = Math.min(Math.max(Number(params.get("page") || "1") || 1, 1), 20);
    const perPage = Math.min(Math.max(Number(params.get("per_page") || "20") || 20, 1), 50);
    if (status && !validProjectStatus(status)) return invalid("Status must be active, paused, or archived.");
    const where = { userId: identity.userId, ...(status ? { status: status as ProjectStatus } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { description: { contains: search, mode: "insensitive" as const } }, { githubRepo: { contains: search, mode: "insensitive" as const } }] } : {}) };
    const [items, total] = await Promise.all([prisma.project.findMany({ where, orderBy: { updatedAt: "desc" }, skip: (page - 1) * perPage, take: perPage }), prisma.project.count({ where })]);
    return NextResponse.json({ items: items.map(publicProject), page, perPage, total, hasNextPage: page * perPage < total });
  } catch (error) { return projectError(error); }
}

export async function POST(request: Request) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return unauthenticated();
     const body = await request.json().catch(() => null) as { name?: unknown; description?: unknown; status?: unknown; githubOwner?: unknown; githubRepo?: unknown; localRepositoryPath?: unknown } | null;
    if (!body || !validProjectName(body.name)) return invalid("Project name is required and must be 1 to 80 characters.");
    if (body.description !== undefined && body.description !== null && (typeof body.description !== "string" || body.description.length > 500)) return invalid("Description must be 500 characters or fewer.");
    const status = body.status === undefined ? "active" : body.status;
    if (!validProjectStatus(status)) return invalid("Status must be active, paused, or archived.");
    const owner = body.githubOwner === undefined ? null : body.githubOwner;
    const repo = body.githubRepo === undefined ? null : body.githubRepo;
    if (!validGithubAssociation(owner, repo)) return invalid("GitHub owner and repository must be provided together and use valid names.");
    const slug = projectSlug(body.name);
    if (!slug) return invalid("Project name must contain letters or numbers.");
    const duplicate = await prisma.project.findUnique({ where: { userId_slug: { userId: identity.userId, slug } } });
    if (duplicate) return NextResponse.json({ code: "duplicate_slug", message: "A project with this name already exists." }, { status: 409 });
     if (owner && repo) await getRepositoryDetail(identity.accessToken, owner as string, repo as string);
     let localRepositoryPath: string | null = null;
     if (body.localRepositoryPath !== undefined && body.localRepositoryPath !== null) { if (typeof body.localRepositoryPath !== "string") return invalid("Local repository path must be relative to GIT_WORKSPACE_ROOT."); const resolved = await resolveRepository(body.localRepositoryPath); localRepositoryPath = body.localRepositoryPath.trim() || "."; void resolved; }
     const project = await prisma.project.create({ data: { userId: identity.userId, name: body.name.trim(), slug, description: typeof body.description === "string" ? body.description.trim() || null : null, status: status as ProjectStatus, githubOwner: owner as string | null, githubRepo: repo as string | null, localRepositoryPath } });
    return NextResponse.json({ project: publicProject(project) }, { status: 201 });
  } catch (error) { return projectError(error); }
}
