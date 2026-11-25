// WhatsApp provider adapters. The simulated one is used until a WhatsApp Business account is connected.
// MetaCloudWhatsApp follows Meta's WhatsApp Cloud API (send: POST /{phone-number-id}/messages; webhooks signed with
// X-Hub-Signature-256 = HMAC-SHA256 of the raw body with the app secret). NOT verified: no account yet. It is only used
// when WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_VERIFIED=1 are set.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ProviderInfo } from "../providers";
import type { Lang } from "./templates";

export interface OutgoingMessage {
  to: string;                     // digits with country code
  phoneNumberId: string | null;   // the clinic's sending number at the provider
  text: string;                   // what the patient will read (already filled in)
  template?: { name: string; language: Lang; params: string[] } | null;  // templates outside the 24-hour window
}
export type WhatsAppEvent =
  | { type: "message"; providerMessageId: string; from: string; to: string; text: string; at: string }
  | { type: "status"; providerMessageId: string; status: "sent" | "delivered" | "read" | "failed"; error?: string; at: string };

export interface WhatsAppProvider {
  readonly info: ProviderInfo;
  send(m: OutgoingMessage): Promise<{ providerMessageId: string }>;
  /** Checks the signature and returns the events in the body. Throws if the signature is wrong. */
  parseWebhook(rawBody: string, headers: Headers): WhatsAppEvent[];
}

function hmacOk(raw: string, sig: string | null, secret: string) {
  if (!sig || !secret) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(sig.replace(/^sha256=/, ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Records messages in memory. Its webhook format is Meta's, signed with WHATSAPP_APP_SECRET (or a test secret). */
export class SimulatedWhatsApp implements WhatsAppProvider {
  readonly info: ProviderInfo = { kind: "whatsapp", name: "Simulated WhatsApp", simulated: true, state: "mock_tested", note: "No WhatsApp Business account connected. Messages are simulated in the app." };
  readonly sent: (OutgoingMessage & { id: string })[] = [];
  constructor(private readonly secret = process.env.WHATSAPP_APP_SECRET ?? "") {}
  async send(m: OutgoingMessage) {
    const id = `sim-wamid-${randomUUID()}`;
    this.sent.push({ ...m, id });
    return { providerMessageId: id };
  }
  parseWebhook(raw: string, headers: Headers) {
    if (!hmacOk(raw, headers.get("x-hub-signature-256"), this.secret)) throw new Error("bad signature");
    return parseMetaBody(raw);
  }
}

/** Meta's webhook body: entry[].changes[].value.{metadata, messages[], statuses[]}. */
export function parseMetaBody(raw: string): WhatsAppEvent[] {
  const body = JSON.parse(raw);
  const out: WhatsAppEvent[] = [];
  for (const e of body.entry ?? []) for (const ch of e.changes ?? []) {
    const v = ch.value ?? {};
    const to = String(v.metadata?.display_phone_number ?? "");
    for (const m of v.messages ?? []) {
      const text = m.type === "text" ? m.text?.body : m.type === "button" ? m.button?.text : m.type === "interactive" ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
      out.push({ type: "message", providerMessageId: String(m.id), from: String(m.from), to, text: String(text ?? `[${m.type} message]`), at: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000).toISOString() });
    }
    for (const s of v.statuses ?? []) {
      if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
      out.push({ type: "status", providerMessageId: String(s.id), status: s.status, error: s.errors?.[0]?.title, at: new Date(Number(s.timestamp ?? Date.now() / 1000) * 1000).toISOString() });
    }
  }
  return out;
}

export class MetaCloudWhatsApp implements WhatsAppProvider {
  readonly info: ProviderInfo = { kind: "whatsapp", name: "WhatsApp Cloud API (Meta)", simulated: false, state: process.env.WHATSAPP_VERIFIED === "1" ? "connection_verified" : "credentials_configured", note: "Templates must be approved in the WhatsApp Business account." };
  constructor(private readonly token: string, private readonly appSecret: string,
              private readonly version = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0", private readonly fetchImpl: typeof fetch = fetch) {}
  request(m: OutgoingMessage) {
    if (!m.phoneNumberId) throw new Error("The clinic's WhatsApp number id is not set.");
    const body = m.template
      ? { messaging_product: "whatsapp", to: m.to, type: "template",
          template: { name: m.template.name, language: { code: m.template.language === "en" ? "en" : m.template.language },
                      components: m.template.params.length ? [{ type: "body", parameters: m.template.params.map((t) => ({ type: "text", text: t })) }] : [] } }
      : { messaging_product: "whatsapp", to: m.to, type: "text", text: { body: m.text } };
    return { url: `https://graph.facebook.com/${this.version}/${m.phoneNumberId}/messages`,
             init: { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) } };
  }
  async send(m: OutgoingMessage) {
    const { url, init } = this.request(m);
    const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp error ${res.status}: ${String(json?.error?.message ?? "").slice(0, 200)}`);
    const id = json?.messages?.[0]?.id;
    if (!id) throw new Error("WhatsApp did not return a message id");
    return { providerMessageId: String(id) };
  }
  parseWebhook(raw: string, headers: Headers) {
    if (!hmacOk(raw, headers.get("x-hub-signature-256"), this.appSecret)) throw new Error("bad signature");
    return parseMetaBody(raw);
  }
}

let provider: WhatsAppProvider | undefined;
export function getWhatsApp(): WhatsAppProvider {
  if (!provider) {
    const { WHATSAPP_ACCESS_TOKEN: t, WHATSAPP_APP_SECRET: s, WHATSAPP_VERIFIED: v } = process.env;
    provider = t && s && v === "1" ? new MetaCloudWhatsApp(t, s) : new SimulatedWhatsApp();
  }
  return provider;
}
/** Tests only. */
export function setWhatsApp(p: WhatsAppProvider | undefined) { provider = p; }
