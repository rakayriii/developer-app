import ProjectWorkspaceDetail from "@/components/project-workspace-detail";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectWorkspaceDetail id={id} />;
}
