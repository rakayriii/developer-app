import GithubSection from "@/components/github-section";

// The routed entry point for the GitHub section. The hash workspace and this route render the same
// workspace, so the section's own nav item is a real URL rather than a 404.
export default function GithubPage() {
  return <GithubSection tab="github" />;
}
