import { NextResponse } from "next/server";
import { getProjectIdentity } from "@/lib/projects/auth";
import { recentChecks, serverError } from "@/lib/servers/service";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const identity = await getProjectIdentity();
    if (!identity) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub before managing servers." }, { status: 401 });
    const { id } = await params;
    return NextResponse.json({ items: await recentChecks(identity.userId, id) });
  } catch (error) {
    const failure = serverError(error);
    return NextResponse.json({ code: failure.code, message: failure.message }, { status: failure.status });
  }
}
