import { NextRequest, NextResponse } from "next/server";
import { requireSystemAuth } from "@/lib/system/auth";
import { getProcessMetrics } from "@/lib/system/processes";
import type { ProcessSort } from "@/lib/system/types";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const sorts = new Set<ProcessSort>(["cpu", "memory", "pid", "name"]);
export async function GET(request: NextRequest) {
  if (!await requireSystemAuth()) return NextResponse.json({ message: "Authentication required." }, { status: 401 });
  const params = request.nextUrl.searchParams; const sortValue = params.get("sort") || "cpu"; const pageValue = params.get("page") || "1"; const limitValue = params.get("limit") || "50";
  if (!sorts.has(sortValue as ProcessSort) || !/^\d+$/.test(pageValue) || !/^\d+$/.test(limitValue) || Number(pageValue) < 1 || Number(limitValue) < 1 || Number(limitValue) > 100) return NextResponse.json({ code: "invalid_query", message: "Use sort=cpu|memory|pid|name, page>=1, and limit between 1 and 100." }, { status: 400 });
  return NextResponse.json(await getProcessMetrics(sortValue as ProcessSort, Number(pageValue), Number(limitValue)));
}
