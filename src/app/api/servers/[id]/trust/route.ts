import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { requireOwnedServer, serverError, trustHostKey } from "@/lib/servers/service";
export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export const maxDuration = 60;

// Explicit trust-on-first-use. This is the only path that records a host key fingerprint, and it is
// never invoked automatically by a connection attempt.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 });
    const { id } = await params;
    await requireOwnedServer(identity.userId, id);
    return NextResponse.json(await trustHostKey(identity.userId, id));
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
