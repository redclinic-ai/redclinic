// Telephony webhook. The provider calls this for call events. Every event is checked (signature), stored once
// (duplicates are ignored), then processed. The reply tells the provider what NEPA says next.
import { NextResponse, type NextRequest } from "next/server";
import { withoutUser } from "@/lib/db";
import { getTelephony } from "@/lib/providers";
import { callerSays, endCall, recordMissedCall, startCall } from "@/lib/calls/service";
import { reportError, log } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const adapter = getTelephony();
  const expected = adapter.info.simulated ? "simulated" : adapter.info.name.toLowerCase();
  if (provider !== expected) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  if (adapter.info.simulated && process.env.APP_ENV === "production" && process.env.ALLOW_SIMULATED_TELEPHONY !== "1") {
    return NextResponse.json({ error: "simulated telephony is off in production" }, { status: 403 });
  }
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let e;
  try { e = adapter.parseWebhook(raw, req.headers); } catch { return NextResponse.json({ error: "invalid signature or body" }, { status: 401 }); }

  const clinicId: string | null = await withoutUser(async (c) => (await c.query("SELECT rc_clinic_for_number($1) AS id", [e.direction === "inbound" ? e.to : e.from])).rows[0].id);
  const fresh = await withoutUser(async (c) => (await c.query("SELECT rc_telephony_event_record($1,$2,$3,$4,$5) AS ok", [e.provider, e.eventId, e.type, JSON.parse(raw), clinicId])).rows[0].ok);
  if (!fresh) return NextResponse.json({ duplicate: true });
  if (!clinicId) {
    await withoutUser((c) => c.query("SELECT rc_telephony_event_done($1,$2,$3)", [e.provider, e.eventId, "number not linked to a clinic"]));
    return NextResponse.json({ error: "number not linked to a clinic" }, { status: 404 });
  }
  try {
    const simulated = adapter.info.simulated;
    const callId = await withoutUser(async (c) => {
      await c.query("SELECT rc_set_context(NULL, $1, false)", [clinicId]);
      return (await c.query("SELECT id FROM calls WHERE provider = $1 AND provider_call_id = $2", [e.provider, e.providerCallId])).rows[0]?.id as string | undefined;
    });
    let body: Record<string, unknown> = { ok: true };
    if (e.type === "call.started" && !callId) {
      const r = await startCall(clinicId, { direction: e.direction, callerNumber: e.direction === "inbound" ? e.from : e.to, simulated, provider: e.provider, providerCallId: e.providerCallId, lang: (e.lang as "en") ?? undefined });
      body = { say: r.reply, end: r.ended, transfer: r.handedOff };
    } else if (e.type === "call.speech" && callId && e.text) {
      const r = await callerSays(clinicId, callId, e.text);
      body = { say: r.reply, end: r.ended, transfer: r.handedOff };
    } else if (e.type === "call.ended" && callId) {
      await endCall(clinicId, callId, "caller_hung_up", { durationSeconds: e.durationSeconds });
    } else if (e.type === "call.missed") {
      await recordMissedCall(clinicId, e.from, { simulated, provider: e.provider, providerCallId: e.providerCallId });
    }
    await withoutUser((c) => c.query("SELECT rc_telephony_event_done($1,$2,NULL)", [e.provider, e.eventId]));
    log("info", "telephony event", { type: e.type, provider: e.provider });
    return NextResponse.json(body);
  } catch (err) {
    reportError(err, { route: "telephony webhook", type: e.type });
    await withoutUser((c) => c.query("SELECT rc_telephony_event_done($1,$2,$3)", [e.provider, e.eventId, (err as Error).message.slice(0, 300)]));
    // tell the provider to hand the caller to a person rather than leave them in silence
    return NextResponse.json({ say: "Sorry, I'm connecting you to the clinic staff.", transfer: true }, { status: 200 });
  }
}
