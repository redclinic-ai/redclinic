// WhatsApp webhook (Meta Cloud API format). GET answers Meta's one-time verification; POST receives replies and
// delivery receipts. Every POST is signature-checked (X-Hub-Signature-256) before anything is read.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getWhatsApp } from "@/lib/whatsapp/provider";
import { receiveWhatsApp } from "@/lib/whatsapp/service";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function providerOk(provider: string) {
  const sim = getWhatsApp().info.simulated;
  if (provider !== (sim ? "simulated" : "meta")) return false;
  return !(sim && process.env.APP_ENV === "production" && process.env.ALLOW_SIMULATED_WHATSAPP !== "1");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!providerOk(provider)) return new NextResponse("not found", { status: 404 });
  const q = req.nextUrl.searchParams;
  const token = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  const given = q.get("hub.verify_token") ?? "";
  const same = token.length > 0 && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (q.get("hub.mode") === "subscribe" && same) return new NextResponse(q.get("hub.challenge") ?? "", { status: 200 });
  return new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!providerOk(provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 200_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let events;
  try { events = getWhatsApp().parseWebhook(raw, req.headers); } catch { return NextResponse.json({ error: "invalid signature or body" }, { status: 401 }); }
  try {
    const results = await receiveWhatsApp(events, { simulated: getWhatsApp().info.simulated });
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    reportError(e, { route: "whatsapp webhook" });
    // 200 would make Meta drop the event; 500 makes it retry, and duplicates are ignored by message id
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
