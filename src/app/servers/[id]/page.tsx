import ServerDetail from "@/components/server-detail";

export default async function ServerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ServerDetail serverId={id} />;
}
