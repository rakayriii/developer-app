import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api/errors";
import { deploymentIdentity, notAuthenticated, forbidden, invalid } from "@/lib/deployments/api";
import { createDomain, listDomains, DomainError } from "@/lib/exposure/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function identity() {
  const owner = await deploymentIdentity();
  return owner ? { owner } : { response: notAuthenticated() };
}

export async function GET(request: Request) {
  try {
    const access = await identity();
    if (access.response) return access.response;
    const deploymentId = new URL(request.url).searchParams.get("deploymentId") || undefined;
    return NextResponse.json({ items: await listDomains(access.owner.userId, deploymentId) });
  } catch (error) {
    return apiErrorResponse(error, { code: "domain_error", message: "Domains could not be loaded." });
  }
}

export async function POST(request: Request) {
  try {
    const access = await identity();
    if (access.response) return access.response;
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return invalid("Request body must be valid JSON.");
    if (typeof body.deploymentId !== "string" || !body.deploymentId) return invalid("A deployment is required.");
    const domain = await createDomain(access.owner.userId, body);
    return NextResponse.json(domain, { status: 201 });
  } catch (error) {
    if (error instanceof DomainError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
    if (error instanceof Error && error.name === "HostnameError") return NextResponse.json({ code: "invalid_hostname", message: error.message }, { status: 400 });
    return apiErrorResponse(error, { code: "domain_error", message: "The domain could not be created." });
  }
}

export { forbidden };