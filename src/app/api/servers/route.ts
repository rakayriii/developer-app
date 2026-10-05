import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { createServer, listServers, serverError } from "@/lib/servers/service";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 });
    return NextResponse.json({ items: await listServers(identity.userId) });
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}

export async function POST(request: Request) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ code: "invalid_server", message: "Request body must be valid JSON." }, { status: 400 });
    return NextResponse.json(await createServer(identity.userId, body), { status: 201 });
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
