// Meta lead ads webhook ("page" object, "leadgen" field). GET answers Meta's verification; POST is signature-checked.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getLeadAds } from "@/lib/leads/provider";
import { receiveLeads } from "@/lib/leads/service";
import { reportError } from "@/lib/monitoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function providerOk(provider: string) {
  const p = getLeadAds();
  if (provider !== p.key) return false;
  return !(p.info.simulated && process.env.APP_ENV === "production" && process.env.ALLOW_SIMULATED_LEADS !== "1");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  if (!providerOk((await params).provider)) return new NextResponse("not found", { status: 404 });
  const q = req.nextUrl.searchParams;
  const token = process.env.META_VERIFY_TOKEN ?? "";
  const given = q.get("hub.verify_token") ?? "";
  const same = token.length > 0 && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  return q.get("hub.mode") === "subscribe" && same ? new NextResponse(q.get("hub.challenge") ?? "") : new NextResponse("forbidden", { status: 403 });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  if (!providerOk((await params).provider)) return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 200_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let notices;
  try { notices = getLeadAds().parseWebhook(raw, req.headers); } catch { return NextResponse.json({ error: "invalid signature or body" }, { status: 401 }); }
  try {
    return NextResponse.json({ ok: true, results: await receiveLeads(notices, { simulated: getLeadAds().info.simulated }) });
  } catch (e) {
    reportError(e, { route: "leads webhook" });
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
