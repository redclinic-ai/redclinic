// Payment webhook. Only a verified event (signature) changes a subscription; browser redirects never do.
// Events are stored once by id (duplicates ignored). Only the simulated provider exists until a gateway is approved.
import { NextResponse, type NextRequest } from "next/server";
import { verifySignature } from "@/lib/providers";
import { applyBillingEvent, type BillingEventType } from "@/lib/billing/service";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const TYPES: BillingEventType[] = ["payment.succeeded", "payment.failed", "subscription.cancelled", "subscription.resumed"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "simulated") return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  if (process.env.APP_ENV === "production" && process.env.ALLOW_SIMULATED_PAYMENTS !== "1") return NextResponse.json({ error: "simulated payments are off in production" }, { status: 403 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-signature"), process.env.BILLING_WEBHOOK_SECRET ?? "")) return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  let e: { eventId?: string; type?: string; invoiceNumber?: string };
  try { e = JSON.parse(raw); } catch { return NextResponse.json({ error: "bad body" }, { status: 400 }); }
  if (!e.eventId || !e.invoiceNumber || !TYPES.includes(e.type as BillingEventType)) return NextResponse.json({ error: "bad event" }, { status: 400 });
  try {
    const r = await applyBillingEvent({ provider, eventId: e.eventId, type: e.type as BillingEventType, invoiceNumber: e.invoiceNumber, simulated: true });
    return NextResponse.json(r);
  } catch (err) {
    reportError(err, { route: "billing webhook" });
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
