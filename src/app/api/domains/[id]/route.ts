import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { deploymentIdentity, notAuthenticated, invalid } from "@/lib/deployments/api";
import { deleteDomain, disableDomain, enableDomain, getDomain, DomainError } from "@/lib/exposure/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function owner() {
  const identity = await deploymentIdentity();
  return identity ? { identity } : { response: notAuthenticated() };
}

function failure(error: unknown, message: string) {
  if (error instanceof DomainError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof Error && error.name === "HostnameError") return NextResponse.json({ code: "invalid_hostname", message: error.message }, { status: 400 });
  return apiErrorResponse(error, { code: "domain_error", message });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await owner();
    if (access.response) return access.response;
    return NextResponse.json(await getDomain(access.identity.userId, id));
  } catch (error) {
    return failure(error, "The domain could not be loaded.");
  }
}

// Enable and disable are explicit operator actions. Disabling withdraws the hostname rather than
// deleting the record, so the routing intent survives and can be turned back on.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await owner();
    if (access.response) return access.response;
    const body = await request.json().catch(() => null) as { action?: unknown } | null;
    const action = body?.action;
    if (action === "enable") return NextResponse.json(await enableDomain(access.identity.userId, id));
    if (action === "disable") return NextResponse.json(await disableDomain(access.identity.userId, id));
    return invalid("Action must be enable or disable.");
  } catch (error) {
    return failure(error, "The domain could not be updated.");
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await owner();
    if (access.response) return access.response;
    return NextResponse.json(await deleteDomain(access.identity.userId, id));
  } catch (error) {
    return failure(error, "The domain could not be removed.");
  }
}