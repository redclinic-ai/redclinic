import { NextResponse, type NextRequest } from "next/server";
import { currentUser } from "@/lib/auth/session-cookie";
import { exportResultsCsv, type Period } from "@/lib/results/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in first.", { status: 401 });
  const p = req.nextUrl.searchParams.get("p");
  const period = (["today", "7d", "30d"].includes(p ?? "") ? p : "7d") as Period;
  const r = await exportResultsCsv(user, period);
  if (!r.ok) return new NextResponse(r.error, { status: 403 });
  return new NextResponse(r.value, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="results-${period}.csv"`, "Cache-Control": "private, no-store" } });
}
