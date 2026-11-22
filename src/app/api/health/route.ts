import { NextResponse } from "next/server";
import { checkHealth } from "@/lib/monitoring/health";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const h = await checkHealth();
  if (!h.ok) reportError(new Error("health check failed"), { checks: h.checks });
  return NextResponse.json(h, { status: h.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
