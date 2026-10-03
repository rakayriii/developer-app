import GithubRepositoryDetail from "@/components/github-repository-detail";

export default async function RepositoryPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  return <GithubRepositoryDetail owner={owner} repo={repo} />;
}
