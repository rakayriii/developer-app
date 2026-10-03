import { NextResponse } from "next/server";
import { requireSystemAuth } from "@/lib/system/auth";
import { getGpuMetrics } from "@/lib/system/gpu";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { if (!await requireSystemAuth()) return NextResponse.json({ message: "Authentication required." }, { status: 401 }); return NextResponse.json(await getGpuMetrics()); }
