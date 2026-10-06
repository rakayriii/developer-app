import { NextResponse } from "next/server";
import { requireSystemAuth } from "@/lib/system/auth";
import { getTemperatureMetrics } from "@/lib/system/temperature";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { if (!await requireSystemAuth()) return NextResponse.json({ code: "not_authenticated", message: "Authentication required." }, { status: 401 }); return NextResponse.json(await getTemperatureMetrics()); }
