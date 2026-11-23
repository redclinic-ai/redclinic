// Scheduler endpoint: run every minute by the host's cron (or an uptime pinger). For every active clinic it runs
// the workflow engine, then places due outgoing calls. Protected by CRON_SECRET.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { withoutUser } from "@/lib/db";
import { runDialer } from "@/lib/calls/service";
import { workflowTick } from "@/lib/workflows/engine";
import { billingTick } from "@/lib/billing/service";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }
  let billing = 0;
  try { billing = (await billingTick()).length; } catch (e) { reportError(e, { route: "cron billing" }); }
  const ids: string[] = await withoutUser(async (c) => (await c.query("SELECT rc_active_clinic_ids() AS id")).rows.map((r) => r.id));
  let placed = 0, failed = 0;
  for (const id of ids) {
    try {
      await workflowTick(id);           // schedule workflow steps first
      placed += (await runDialer(id)).length;
    } catch (e) { failed++; reportError(e, { route: "cron jobs", clinic: id }); }
  }
  return NextResponse.json({ clinics: ids.length, placed, failed, billingChanges: billing });
}
