import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { requireOwnedServer, serverError, testServer } from "@/lib/servers/service";
export const runtime = "nodejs"; export const dynamic = "force-dynamic"; export const maxDuration = 120;

// Connection test. Runs only the fixed server-side probes; there is no command parameter and no
// arbitrary shell endpoint exists.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 });
    const { id } = await params;
    await requireOwnedServer(identity.userId, id);
    const outcome = await testServer(identity.userId, id);
    return NextResponse.json(outcome, { status: outcome.check.status === "online" ? 200 : 200 });
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
