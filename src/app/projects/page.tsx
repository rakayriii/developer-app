import ProjectWorkspaceList from "@/components/project-workspace";

// The routed entry point for the Projects section. The hash workspace and this route render the same
// component, so the section's own nav item is a real URL rather than a 404.
export default function ProjectsPage() {
  return <ProjectWorkspaceList />;
}
