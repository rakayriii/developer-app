import { NextResponse } from "next/server";
import { deploymentError, deploymentIdentity, notAuthenticated } from "@/lib/deployments/api";
import { runtimeVariableAllowlist } from "@/lib/deployments/runtime-env";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

// Server-owned catalog of permitted runtime variable names. Values are never stored here.
export async function GET() { try { if (!await deploymentIdentity()) return notAuthenticated(); return NextResponse.json(Object.entries(runtimeVariableAllowlist).map(([name, spec]) => ({ name, secret: spec.secret, description: spec.description, configured: false, value: null }))); } catch (error) { return deploymentError(error); } }
