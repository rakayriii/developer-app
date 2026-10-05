import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { GitValidationError } from "@/lib/git/validation";
import { DeploymentDockerError } from "./docker";
import { DeploymentConflictError } from "./errors";
import { DeploymentTransitionError } from "./lifecycle";
import { DeploymentOwnershipError } from "./operations";

export async function deploymentIdentity() { return getProjectIdentity(); }
function errorCode(error: unknown) { return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined; }
function safeDiagnostic(error: unknown) { const message = error instanceof Error ? error.message : "Unknown deployment error."; return message.replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, "postgresql://[redacted]"); }
export function deploymentError(error: unknown, context = "deployment_api") {
  const code = errorCode(error);
  console.error(JSON.stringify({ service: "deployments", event: "request_failed", context, error: { name: error instanceof Error ? error.name : "UnknownError", code, message: safeDiagnostic(error) } }));
  if (error instanceof GitValidationError || error instanceof DeploymentDockerError || error instanceof DeploymentConflictError || error instanceof DeploymentTransitionError || error instanceof DeploymentOwnershipError) return NextResponse.json({ code: error.code, message: error.message }, { status: error.status });
  if (error instanceof Error && error.message === "Environment not found.") return NextResponse.json({ code: "not_found", message: error.message }, { status: 404 });
  if (error instanceof Error && error.message === "Deployment not found.") return NextResponse.json({ code: "not_found", message: error.message }, { status: 404 });
  if (code === "P2021" || code === "P1001" || code === "P1003") return NextResponse.json({ code: "database_configuration_error", message: "Deployment database tables are not available. Apply the latest Prisma migration." }, { status: 503 });
  return NextResponse.json({ code: "deployment_error", message: "Deployment operation failed. Check the server deployment log for details." }, { status: 500 });
}
export function notAuthenticated() { return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing deployments." }, { status: 401 }); }
export function forbidden() { return NextResponse.json({ code: "forbidden", message: "You do not own this project." }, { status: 403 }); }
export function invalid(message: string) { return NextResponse.json({ code: "validation_error", message }, { status: 400 }); }
