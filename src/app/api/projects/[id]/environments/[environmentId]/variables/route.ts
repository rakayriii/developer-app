import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deploymentError, deploymentIdentity, forbidden, invalid, notAuthenticated } from "@/lib/deployments/api";
import { parseRuntimeVariableList, RuntimeVariableError } from "@/lib/deployments/runtime-env";
import { describeRuntimeVariables, replaceRuntimeVariables } from "@/lib/deployments/runtime-store";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

async function owned(projectId: string, environmentId: string) { const identity = await deploymentIdentity(); if (!identity) return { response: notAuthenticated() }; const environment = await prisma.deploymentEnvironment.findFirst({ where: { id: environmentId, projectId, project: { userId: identity.userId } } }); if (!environment) return { response: forbidden() }; return { environment }; }

// Returns variable names and configuration state only. Secret values are write-only and never serialized.
export async function GET(_request: Request, context: { params: Promise<{ id: string; environmentId: string }> }) { try { const { id, environmentId } = await context.params; const access = await owned(id, environmentId); if (access.response) return access.response; return NextResponse.json(await describeRuntimeVariables(environmentId)); } catch (error) { return deploymentError(error); } }

export async function PUT(request: Request, context: { params: Promise<{ id: string; environmentId: string }> }) { try { const { id, environmentId } = await context.params; const access = await owned(id, environmentId); if (access.response) return access.response; const body = await request.json().catch(() => null) as Record<string, unknown> | null; if (!body) return invalid("Request body must be valid JSON."); let variables; try { variables = parseRuntimeVariableList(body); } catch (error) { if (error instanceof RuntimeVariableError) return invalid(error.message); throw error; } const active = await prisma.deployment.count({ where: { environmentId, status: { in: ["running", "starting", "building"] } } }); if (active) return NextResponse.json({ code: "environment_active", message: "Stop active deployments before changing runtime variables." }, { status: 409 }); return NextResponse.json(await replaceRuntimeVariables(environmentId, variables)); } catch (error) { return deploymentError(error); } }

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; environmentId: string }> }) { return PUT(new Request("http://localhost", { method: "PUT", body: JSON.stringify({ variables: [] }) }), context); }
