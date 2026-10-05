import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { deleteServer, requireOwnedServer, serverError, updateServer } from "@/lib/servers/service";
import { toPublicServer } from "@/lib/servers/serialize";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

// Every handler here is scoped to the authenticated user, so one account can never read or mutate
// another account's server, hostname, fingerprint, or metadata.
async function context(request: Request, params: Promise<{ id: string }>) {
  const identity = await getProjectIdentity();
  if (!identity) return { response: NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 }) };
  const { id } = await params;
  try {
    const server = await requireOwnedServer(identity.userId, id);
    return { identity, server };
  } catch (error) {
    const failure = serverError(error);
    return { response: NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status }) };
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await context(_request, params);
  if (access.response) return access.response;
  return NextResponse.json(toPublicServer(access.server));
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await context(request, params);
  if (access.response) return access.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ code: "invalid_server", message: "Request body must be valid JSON." }, { status: 400 });
  try {
    return NextResponse.json(await updateServer(access.identity.userId, access.server.id, body));
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await context(_request, params);
  if (access.response) return access.response;
  try {
    return NextResponse.json(await deleteServer(access.identity.userId, access.server.id));
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
