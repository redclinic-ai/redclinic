// Provider adapters. Every paid service sits behind an interface with a simulated implementation.
// Integration state (master prompt section 23) is reported per adapter so nothing simulated is shown as real.

import { createHmac, timingSafeEqual } from "node:crypto";

export type IntegrationState =
  | "architecture_ready" | "adapter_implemented" | "mock_tested" | "provider_selected"
  | "credentials_configured" | "connection_verified" | "e2e_passed" | "production_active";

export interface ProviderInfo { kind: string; name: string; simulated: boolean; state: IntegrationState; note: string }

// ---------- telephony ----------
export interface TelephonyEvent {
  provider: string; eventId: string; type: "call.started" | "call.speech" | "call.ended" | "call.missed" | "recording.ready";
  providerCallId: string; to: string; from: string; direction: "inbound" | "outbound"; text?: string; lang?: string;
  recordingUrl?: string; durationSeconds?: number; at: string;
}
export interface TelephonyAdapter {
  readonly info: ProviderInfo;
  placeCall(input: { to: string; from: string; clinicId: string; callId: string }): Promise<{ providerCallId: string }>;
  transfer(providerCallId: string, to: string): Promise<void>;
  hangup(providerCallId: string): Promise<void>;
  /** Checks the webhook signature and turns the body into an event. Throws if the signature is wrong. */
  parseWebhook(rawBody: string, headers: Headers): TelephonyEvent;
}

/** Generic signed-webhook format (HMAC-SHA256 of the raw body). Used by the simulated provider and as the contract for real ones. */
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"));
  const given = Buffer.from(signature.replace(/^sha256=/, ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class SimulatedTelephony implements TelephonyAdapter {
  readonly info: ProviderInfo = { kind: "telephony", name: "Simulated telephony", simulated: true, state: "mock_tested", note: "No telephony provider selected. Calls are simulated in the app." };
  readonly placed: { to: string; callId: string }[] = [];
  async placeCall(input: { to: string; callId: string }) { this.placed.push(input); return { providerCallId: `sim-${input.callId}` }; }
  async transfer() {}
  async hangup() {}
  parseWebhook(rawBody: string, headers: Headers): TelephonyEvent {
    const secret = process.env.TELEPHONY_WEBHOOK_SECRET ?? "";
    if (!verifySignature(rawBody, headers.get("x-signature"), secret)) throw new Error("bad signature");
    const e = JSON.parse(rawBody);
    if (!e.eventId || !e.type || !e.providerCallId) throw new Error("bad event");
    return { provider: "simulated", ...e };
  }
}

// ---------- speech to text (for recordings of real calls) ----------
export interface TranscriptSegment { speaker: "nepa" | "caller" | "staff"; text: string; lang: string; atMs: number }
export interface SpeechToText {
  readonly info: ProviderInfo;
  transcribe(input: { audio: Buffer; format: string; languages: string[] }): Promise<TranscriptSegment[]>;
}
export class SimulatedSpeechToText implements SpeechToText {
  readonly info: ProviderInfo = { kind: "speech_to_text", name: "Simulated speech-to-text", simulated: true, state: "mock_tested", note: "Provider not selected. Simulated calls are transcribed from the conversation itself." };
  failNext = 0;
  async transcribe(): Promise<TranscriptSegment[]> {
    if (this.failNext > 0) { this.failNext--; throw new Error("Simulated transcription failure"); }
    // never invents speech: returns nothing it did not hear
    return [];
  }
}

// ---------- text to speech ----------
export interface TextToSpeech {
  readonly info: ProviderInfo;
  synthesize(input: { text: string; voiceId: string; lang: string }): Promise<{ audio: Buffer; format: string }>;
}
export class SimulatedTextToSpeech implements TextToSpeech {
  readonly info: ProviderInfo = { kind: "text_to_speech", name: "Simulated voice", simulated: true, state: "mock_tested", note: "Text only. Cartesia is used once its key is configured and verified." };
  async synthesize() { return { audio: Buffer.alloc(0), format: "none" }; }
}

/**
 * Cartesia text-to-speech (selected by the founder). Written to Cartesia's documented /tts/bytes endpoint.
 * NOT verified: no credentials yet. Enabled only when CARTESIA_API_KEY is set and CARTESIA_VERIFIED=1 after a
 * successful connection test, so it can never be used silently before it is checked.
 */
export class CartesiaTextToSpeech implements TextToSpeech {
  constructor(private readonly apiKey: string, private readonly model = process.env.CARTESIA_MODEL ?? "sonic-2", private readonly version = process.env.CARTESIA_API_VERSION ?? "2025-04-16") {}
  readonly info: ProviderInfo = { kind: "text_to_speech", name: "Cartesia", simulated: false, state: process.env.CARTESIA_VERIFIED === "1" ? "connection_verified" : "credentials_configured", note: "Selected by founder." };
  async synthesize(input: { text: string; voiceId: string; lang: string }) {
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: { "X-API-Key": this.apiKey, "Cartesia-Version": this.version, "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: this.model, transcript: input.text, language: input.lang,
        voice: { mode: "id", id: input.voiceId },
        output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 16000 },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Cartesia error ${res.status}`);
    return { audio: Buffer.from(await res.arrayBuffer()), format: "wav-pcm16-16khz-1ch" };
  }
}

// ---------- call summaries ----------
export interface Summarizer {
  readonly info: ProviderInfo;
  summarize(input: { turns: { speaker: string; text: string }[]; intent: string | null; outcome: string | null; lang: string }): Promise<string>;
}
const OUTCOME: Record<string, string> = {
  booked: "Appointment booked.", booking_requested: "Appointment requested; waiting for staff approval.", cancelled: "Appointment cancelled.",
  confirmed: "Appointment confirmed.", request_sent: "Request sent to staff.", answered: "Question answered from the clinic's approved answers.",
  callback_needed: "Staff need to call back.", handed_to_staff: "Handed to staff.", escalated_emergency: "EMERGENCY: caller told to call 108/112; staff alerted.",
  action_failed: "An action failed; staff need to follow up.", ended_by_caller: "Caller ended the call.",
};
const INTENT: Record<string, string> = {
  booking: "wanted an appointment", cancel: "wanted to cancel", reschedule: "wanted to change an appointment", faq: "asked a question",
  question: "asked a question", medical_question: "asked for medical advice", complaint: "made a complaint", emergency: "described an emergency",
  speak_to_staff: "asked to speak to staff", availability_question: "asked about availability", confirmation: "was asked to confirm an appointment",
};
/** Builds the summary only from what was said and done. Never adds facts. */
export class RuleSummarizer implements Summarizer {
  readonly info: ProviderInfo = { kind: "llm", name: "Rule-based summary", simulated: true, state: "mock_tested", note: "LLM not selected. Summaries are built from the recorded intent and outcome only." };
  async summarize(input: { turns: { speaker: string; text: string }[]; intent: string | null; outcome: string | null; lang?: string }) {
    const callerLines = input.turns.filter((t) => t.speaker === "caller");
    const first = callerLines[0]?.text;
    const parts = [
      input.intent ? `Caller ${INTENT[input.intent] ?? input.intent.replace(/_/g, " ")}.` : callerLines.length ? "" : "Caller did not speak.",
      first ? `They said: “${first.slice(0, 140)}${first.length > 140 ? "…" : ""}”` : "",
      input.outcome ? OUTCOME[input.outcome] ?? input.outcome.replace(/_/g, " ") : "",
    ];
    return parts.filter(Boolean).join(" ");
  }
}

// ---------- registry ----------
let telephony: TelephonyAdapter | undefined;
let stt: SpeechToText | undefined;
let tts: TextToSpeech | undefined;
let summarizer: Summarizer | undefined;

export function getTelephony(): TelephonyAdapter { return (telephony ??= new SimulatedTelephony()); }
export function getSpeechToText(): SpeechToText { return (stt ??= new SimulatedSpeechToText()); }
export function getTextToSpeech(): TextToSpeech {
  if (!tts) tts = process.env.CARTESIA_API_KEY && process.env.CARTESIA_VERIFIED === "1" ? new CartesiaTextToSpeech(process.env.CARTESIA_API_KEY) : new SimulatedTextToSpeech();
  return tts;
}
export function getSummarizer(): Summarizer { return (summarizer ??= new RuleSummarizer()); }
/** Tests only. */
export function setProviders(p: { telephony?: TelephonyAdapter; stt?: SpeechToText; tts?: TextToSpeech; summarizer?: Summarizer }) {
  if (p.telephony) telephony = p.telephony; if (p.stt) stt = p.stt; if (p.tts) tts = p.tts; if (p.summarizer) summarizer = p.summarizer;
}

export function integrationStatus(): ProviderInfo[] {
  return [
    getTelephony().info, getSpeechToText().info, getTextToSpeech().info, getSummarizer().info,
    { kind: "llm_conversation", name: "Rule-based conversation model", simulated: true, state: "mock_tested", note: "LLM not selected. NEPA follows fixed, approved responses." },
    { kind: "payments", name: "Simulated payments", simulated: true, state: "mock_tested", note: "Gateway not approved. Billing events are simulated." },
    { kind: "email", name: "Simulated email", simulated: true, state: "mock_tested", note: "Provider not selected. Emails go to the server log." },
  ];
}
