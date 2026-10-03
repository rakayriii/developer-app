import { validRepositoryPart } from "@/lib/github/repository";

export const statuses = ["active", "paused", "archived"] as const;
export type ProjectStatusValue = (typeof statuses)[number];
export function validProjectStatus(value: unknown): value is ProjectStatusValue { return typeof value === "string" && statuses.includes(value as ProjectStatusValue); }
export function projectSlug(name: string) { return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80); }
export function validProjectName(value: unknown): value is string { return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 80; }
export function validGithubAssociation(owner: unknown, repo: unknown) { return (owner === null && repo === null) || (typeof owner === "string" && typeof repo === "string" && validRepositoryPart(owner) && validRepositoryPart(repo)); }
export function publicProject(project: { id: string; name: string; slug: string; description: string | null; status: string; githubOwner: string | null; githubRepo: string | null; localRepositoryPath?: string | null; createdAt: Date; updatedAt: Date }) { return { id: project.id, name: project.name, slug: project.slug, description: project.description, status: project.status, githubOwner: project.githubOwner, githubRepo: project.githubRepo, localRepositoryPath: project.localRepositoryPath || null, createdAt: project.createdAt, updatedAt: project.updatedAt }; }
