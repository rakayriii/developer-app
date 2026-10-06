import DeploymentDetail from "@/components/deployment-detail";

export default async function DeploymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeploymentDetail deploymentId={id} />;
}
