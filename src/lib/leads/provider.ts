// Meta lead ads. Meta sends a "leadgen" webhook (object "page", field "leadgen") with the lead id and form id only;
// the answers are fetched from the Graph API with a page access token (GET /{lead-id}?fields=field_data,...).
// MetaLeadAds is NOT verified (no account yet): used only when META_PAGE_ACCESS_TOKEN, META_APP_SECRET and
// META_LEADS_VERIFIED=1 are set. The simulated provider accepts the answers inside the webhook body.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderInfo } from "../providers";

export interface LeadNotice { leadId: string; formId: string; pageId: string; createdAt: string; fieldData?: FieldData; campaign?: Record<string, string> }
export type FieldData = { name: string; values: string[] }[];
export interface LeadDetails { fieldData: FieldData; campaign: Record<string, string> }

export interface LeadAdsProvider {
  readonly info: ProviderInfo;
  readonly key: "simulated" | "meta";
  parseWebhook(raw: string, headers: Headers): LeadNotice[];
  fetchLead(n: LeadNotice): Promise<LeadDetails>;
}

function signed(raw: string, sig: string | null, secret: string) {
  if (!sig || !secret) return false;
  const a = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const b = Buffer.from(sig.replace(/^sha256=/, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function notices(raw: string): LeadNotice[] {
  const body = JSON.parse(raw);
  const out: LeadNotice[] = [];
  for (const e of body.entry ?? []) for (const ch of e.changes ?? []) {
    if (ch.field !== "leadgen") continue;
    const v = ch.value ?? {};
    out.push({ leadId: String(v.leadgen_id), formId: String(v.form_id), pageId: String(v.page_id ?? e.id ?? ""),
      createdAt: new Date(Number(v.created_time ?? Date.now() / 1000) * 1000).toISOString(), fieldData: v.field_data, campaign: v.campaign });
  }
  return out;
}

export class SimulatedLeadAds implements LeadAdsProvider {
  readonly key = "simulated" as const;
  readonly info: ProviderInfo = { kind: "lead_ads", name: "Simulated lead ads", simulated: true, state: "mock_tested", note: "No Meta app connected. Leads can be sent in test mode." };
  constructor(private readonly secret = process.env.META_APP_SECRET ?? "") {}
  parseWebhook(raw: string, headers: Headers) {
    if (!signed(raw, headers.get("x-hub-signature-256"), this.secret)) throw new Error("bad signature");
    return notices(raw);
  }
  async fetchLead(n: LeadNotice) { return { fieldData: n.fieldData ?? [], campaign: n.campaign ?? {} }; }
}

export class MetaLeadAds implements LeadAdsProvider {
  readonly key = "meta" as const;
  readonly info: ProviderInfo = { kind: "lead_ads", name: "Meta lead ads", simulated: false, state: process.env.META_LEADS_VERIFIED === "1" ? "connection_verified" : "credentials_configured", note: "Needs the leads_retrieval permission on the clinic's page." };
  constructor(private readonly token: string, private readonly secret: string,
              private readonly version = process.env.META_GRAPH_VERSION ?? "v21.0", private readonly fetchImpl: typeof fetch = fetch) {}
  parseWebhook(raw: string, headers: Headers) {
    if (!signed(raw, headers.get("x-hub-signature-256"), this.secret)) throw new Error("bad signature");
    return notices(raw);
  }
  async fetchLead(n: LeadNotice): Promise<LeadDetails> {
    const url = `https://graph.facebook.com/${this.version}/${encodeURIComponent(n.leadId)}?fields=field_data,ad_id,ad_name,adset_name,campaign_name,form_id`;
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Meta lead fetch failed ${res.status}: ${String(j?.error?.message ?? "").slice(0, 200)}`);
    const campaign = Object.fromEntries(["ad_id", "ad_name", "adset_name", "campaign_name"].filter((k) => j[k]).map((k) => [k, String(j[k])]));
    return { fieldData: Array.isArray(j.field_data) ? j.field_data : [], campaign };
  }
}

let provider: LeadAdsProvider | undefined;
export function getLeadAds(): LeadAdsProvider {
  if (!provider) {
    const { META_PAGE_ACCESS_TOKEN: t, META_APP_SECRET: s, META_LEADS_VERIFIED: v } = process.env;
    provider = t && s && v === "1" ? new MetaLeadAds(t, s) : new SimulatedLeadAds();
  }
  return provider;
}
/** Tests only. */
export function setLeadAds(p: LeadAdsProvider | undefined) { provider = p; }

/** Picks the usual Meta form fields (full_name, phone_number, email) and keeps everything else as answers. */
export function readFields(fd: FieldData) {
  const get = (...keys: string[]) => fd.find((f) => keys.includes(f.name.toLowerCase()))?.values?.[0]?.trim() ?? "";
  const first = get("first_name"), last = get("last_name");
  const name = get("full_name", "name") || [first, last].filter(Boolean).join(" ");
  const phone = get("phone_number", "phone", "mobile", "mobile_number");
  const email = get("email");
  const problem = get("problem", "treatment", "concern", "what_do_you_need_help_with", "service");
  const optIn = /^(yes|true|1|haan)$/i.test(get("whatsapp_opt_in", "whatsapp", "whatsapp_updates"));
  const known = new Set(["full_name", "name", "first_name", "last_name", "phone_number", "phone", "mobile", "mobile_number", "email", "whatsapp_opt_in", "whatsapp", "whatsapp_updates"]);
  const answers = Object.fromEntries(fd.filter((f) => !known.has(f.name.toLowerCase())).map((f) => [f.name, f.values.join(", ")]));
  return { name, phone, email, problem, optIn, answers };
}
