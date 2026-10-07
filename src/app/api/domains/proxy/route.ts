import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { deploymentIdentity, notAuthenticated, invalid } from "@/lib/deployments/api";
import { reconcileServer, removeProxy, DomainError } from "@/lib/exposure/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown, message: string) {
  if (error instanceof DomainError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
  return apiErrorResponse(error, { code: "proxy_error", message });
}

/**
 * Reconciles a server's reverse proxy against its recorded domains, or removes the proxy once no domains
 * remain. Reconcile is deliberately a whole-server operation: the proxy carries every hostname for that
 * server, so a partial rewrite would silently drop the others.
 */
export async function POST(request: Request) {
  try {
    const identity = await deploymentIdentity();
    if (!identity) return notAuthenticated();
    const body = await request.json().catch(() => null) as { serverId?: unknown; action?: unknown } | null;
    if (!body || typeof body.serverId !== "string" || !body.serverId) return invalid("A server is required.");

    // The server must belong to the caller. A reconcile reached through someone else's server id would
    // rewrite a proxy they do not control.
    const owned = await (await import("@/lib/db")).prisma.server.findFirst({ where: { id: body.serverId, userId: identity.userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ code: "server_not_found", message: "The server was not found." }, { status: 404 });

    if (body.action === "remove_proxy") {
      if (await removeProxy(identity.userId, body.serverId)) return NextResponse.json({ ok: true });
    }
    return NextResponse.json(await reconcileServer(body.serverId));
  } catch (error) {
    return failure(error, "The reverse proxy could not be reconciled.");
  }
}