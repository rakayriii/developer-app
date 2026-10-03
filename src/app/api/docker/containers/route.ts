import { NextResponse } from "next/server";
import { DockerError, getDockerContainers } from "@/lib/docker/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json({ items: await getDockerContainers() }); } catch (error) { const dockerError = error instanceof DockerError ? error : new DockerError("unavailable", "Docker daemon is unavailable.", 503); return NextResponse.json({ code: dockerError.code, message: dockerError.message }, { status: dockerError.status }); }
}
