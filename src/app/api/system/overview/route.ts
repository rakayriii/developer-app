import { NextResponse } from "next/server";
import { requireSystemAuth } from "@/lib/system/auth";
import { getSystemOverview } from "@/lib/system/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!await requireSystemAuth()) return NextResponse.json({ code: "not_authenticated", message: "Connect GitHub to view system metrics." }, { status: 401 });
  return NextResponse.json(await getSystemOverview(), { headers: { "Cache-Control": "no-store" } });
}
