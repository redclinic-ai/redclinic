import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth/session-cookie";
import { exportPatientsCsv } from "@/lib/patients/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse("Sign in first.", { status: 401 });
  const r = await exportPatientsCsv(user);
  if (!r.ok) return new NextResponse(r.error, { status: 403 });
  return new NextResponse(r.value, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="patients-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
