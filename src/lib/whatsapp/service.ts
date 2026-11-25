// WhatsApp channel (V2). Three paths:
//  1. Workflows and NEPA queue messages (queueWhatsApp) through the same permission engine as outgoing calls.
//  2. The scheduler sends due messages (runWhatsApp), never at night, never to a patient without opt-in.
//  3. The webhook brings replies and delivery receipts (receiveWhatsApp). Simple replies are acted on
//     (1 = confirm, 2 = change, STOP/START); anything else goes to staff in Messages and Needs attention.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";
import { withContext, withoutUser, type DbContext } from "../db";
import { resolve } from "../nepa/resolver";
import { decideOutbound } from "../nepa/tools";
import { entitlements } from "../billing/service";
import { queueOutbound } from "../calls/service";
import { reportError } from "../monitoring";
import { getWhatsApp, SimulatedWhatsApp, type WhatsAppEvent } from "./provider";
import { describeMissing, render, TEMPLATE_KEYS, TEMPLATES, type Lang, type TemplateKey } from "./templates";

const clinicCtx = (clinicId: string): DbContext => ({ userId: null, clinicId, isSuperAdmin: false });
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
/** Indian 10-digit mobiles get the 91 country code; anything already longer is kept. */
export const toE164Digits = (phone: string | null | undefined) => { const d = digits(phone); return d.length === 10 ? `91${d}` : d.length === 11 && d.startsWith("0") ? `91${d.slice(1)}` : d; };
let sink: SimulatedWhatsApp | undefined;
const simulatedSink = () => (sink ??= new SimulatedWhatsApp());
const allowSimulated = () => process.env.APP_ENV !== "production" || process.env.ALLOW_SIMULATED_WHATSAPP === "1";

// ---------- clinic settings ----------

const SettingsInput = z.object({
  status: z.enum(["off", "simulated", "connected"]),
  businessNumber: z.string().trim().transform(digits).refine((d) => d === "" || (d.length >= 11 && d.length <= 15), "Enter the WhatsApp number with country code, e.g. 91 98xxx xxxxx."),
  phoneNumberId: z.string().trim().max(40).regex(/^\d*$/, "The number id is digits only (from WhatsApp Manager)."),
  mapsUrl: z.string().trim().max(500).refine((u) => u === "" || /^https:\/\//.test(u), "Paste a link starting with https:// (Google Maps → Share → Copy link)."),
  reviewUrl: z.string().trim().max(500).refine((u) => u === "" || /^https:\/\//.test(u), "Paste your Google review link starting with https://."),
});

export async function getWhatsAppSettings(actor: SignedInUser) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const s = (await c.query("SELECT * FROM clinic_whatsapp WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    const counts = (await c.query(
      `SELECT count(*) FILTER (WHERE whatsapp_status = 'opted_in')::int AS opted_in, count(*) FILTER (WHERE whatsapp_status = 'opted_out')::int AS opted_out,
              count(*)::int AS patients FROM patients WHERE merged_into IS NULL`)).rows[0];
    return {
      status: (s?.status ?? "off") as "off" | "simulated" | "connected", businessNumber: s?.business_number ?? "", phoneNumberId: s?.phone_number_id ?? "",
      mapsUrl: s?.maps_url ?? "", reviewUrl: s?.review_url ?? "", provider: getWhatsApp().info, counts, simulatedAllowed: allowSimulated(),
    };
  });
}

export async function saveWhatsAppSettings(actor: SignedInUser, input: Record<string, string>) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = SettingsInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const v = p.data;
    if (v.status === "connected" && getWhatsApp().info.simulated) throw new UserError("RedClinic has not connected a WhatsApp Business account yet. Use test mode for now.", "status");
    if (v.status === "simulated" && !allowSimulated()) throw new UserError("Test mode is not available on the live system.", "status");
    if (v.status !== "off" && !v.businessNumber) throw new UserError("Enter the clinic's WhatsApp number.", "businessNumber");
    if (v.status === "connected" && !v.phoneNumberId) throw new UserError("Enter the number id from WhatsApp Manager.", "phoneNumberId");
    const clash = v.businessNumber && v.status !== "off"
      ? (await c.query("SELECT rc_whatsapp_clinic_for_number($1) AS id", [v.businessNumber])).rows[0].id : null;
    if (clash && clash !== actor.clinicId) throw new UserError("That WhatsApp number is already used by another clinic.", "businessNumber");
    await c.query(
      `INSERT INTO clinic_whatsapp (clinic_id, status, provider, business_number, phone_number_id, maps_url, review_url, updated_by, updated_at)
       VALUES ($1,$2,$3,nullif($4,''),nullif($5,''),nullif($6,''),nullif($7,''),$8, now())
       ON CONFLICT (clinic_id) DO UPDATE SET status=$2, provider=$3, business_number=nullif($4,''), phone_number_id=nullif($5,''),
         maps_url=nullif($6,''), review_url=nullif($7,''), updated_by=$8, updated_at=now()`,
      [actor.clinicId, v.status, v.status === "connected" ? "meta_cloud" : "simulated", v.businessNumber, v.phoneNumberId, v.mapsUrl, v.reviewUrl, actor.userId]);
    await audit(c, actor, "whatsapp_settings_saved", "clinic", actor.clinicId!, { status: v.status });
    return v.status;
  });
}

/** Staff record a patient's WhatsApp choice (and preferred language for messages). */
export async function setPatientWhatsApp(actor: SignedInUser, patientId: string, input: { status: string; language?: string }) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_patient");
    if (!["opted_in", "opted_out"].includes(input.status)) throw new UserError("Choose whether the patient agreed to WhatsApp messages.");
    const lang = input.language && ["en", "hi", "kn"].includes(input.language) ? input.language : null;
    const r = await c.query(
      `UPDATE patients SET whatsapp_status = $2, whatsapp_status_at = now(), whatsapp_status_by = $3, preferred_language = coalesce($4, preferred_language)
        WHERE id = $1 AND merged_into IS NULL RETURNING id`, [patientId, input.status, `staff:${actor.userId}`, lang]);
    if (!r.rowCount) throw new UserError("Patient not found.");
    await audit(c, actor, input.status === "opted_in" ? "whatsapp_opt_in_recorded" : "whatsapp_opt_out_recorded", "patient", patientId);
    return input.status;
  });
}

// ---------- queueing (workflows and NEPA) ----------

interface QueueInput {
  patientId: string; template: TemplateKey; appointmentId?: string | null; workflowId?: string | null;
  simulated?: boolean; dueAt?: Date; vars?: Record<string, string>;
}
export type QueueResult = { messageId: string | null; mode: "prohibited" | "suggest" | "approval_required" | "automatic"; reason: string };

async function appointmentWhen(c: PoolClient, appointmentId: string | null | undefined, lang: Lang) {
  if (!appointmentId) return null;
  const a = (await c.query("SELECT * FROM rc_wf_appointment($1)", [appointmentId])).rows[0];
  if (!a) return null;
  return new Date(a.starts_at).toLocaleString(lang === "en" ? "en-IN" : `${lang}-IN`, { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
}

export async function queueWhatsApp(clinicId: string, input: QueueInput): Promise<QueueResult> {
  return withContext(clinicCtx(clinicId), async (c) => {
    const id = randomUUID();
    const skip = async (reason: string, mode: QueueResult["mode"] = "prohibited"): Promise<QueueResult> => {
      await c.query(
        `INSERT INTO whatsapp_messages (id, clinic_id, patient_id, direction, template_key, body, status, peer_number, appointment_id, workflow_id, error, is_simulated)
         VALUES ($1, rc_clinic_id(), $2, 'out', $3, '', 'skipped', '', $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [id, input.patientId, input.template, input.appointmentId ?? null, input.workflowId ?? null, reason, !!input.simulated]);
      return { messageId: null, mode, reason };
    };
    const wa = (await c.query("SELECT * FROM clinic_whatsapp WHERE clinic_id = rc_clinic_id()")).rows[0];
    if (!wa || wa.status === "off") return skip("WhatsApp is not connected for this clinic.");
    if (!(await c.query("SELECT rc_feature_enabled('whatsapp') AS on")).rows[0].on) return skip("WhatsApp is switched off for this clinic by RedClinic.");
    const p = (await c.query("SELECT * FROM rc_nepa_patient_brief($1)", [input.patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    const wp = (await c.query("SELECT * FROM rc_whatsapp_patient($1)", [p.phone ?? ""])).rows[0];
    if (!wp || wp.id !== input.patientId) return skip("The patient has no mobile number on record.");
    if (wp.whatsapp_status === "opted_out") return skip("The patient asked not to get WhatsApp messages.");
    if (wp.whatsapp_status !== "opted_in") return skip("The patient has not agreed to WhatsApp messages yet. Record their agreement on their page.");
    const ent = await entitlements(c);
    if (!ent.serviceActive) return skip("The clinic's RedClinic plan is not active.");
    const allow = (await c.query("SELECT * FROM rc_whatsapp_allowance()")).rows[0];
    if (allow.allowance !== null && allow.used >= allow.allowance && !input.simulated) return skip("The plan's WhatsApp messages for this period are used up.");

    const r = await resolve(c, "reminder");
    const lang = (wp.preferred_language ?? "en") as Lang;
    const filled = render(input.template, lang, {
      name: p.name.split(" ")[0], clinic: r.knowledge.clinic.name, assistant: r.agentConfig?.name ?? "the clinic assistant",
      phone: r.knowledge.clinic.phone, maps: wa.maps_url, review: wa.review_url,
      when: await appointmentWhen(c, input.appointmentId, lang), service: "visit", ...input.vars,
    });
    if (!filled.ok) return skip(`Cannot send “${TEMPLATES[input.template].label}”: add ${describeMissing(filled.missing)} in Settings → WhatsApp.`);

    const d = await decideOutbound({ c, r, callId: null, simulated: !!input.simulated }, "send_whatsapp", input.workflowId ?? null, p.consent_status);
    if (d.mode === "prohibited" || d.mode === "suggest") return skip(d.reason, d.mode);
    let approvalId: string | null = null;
    if (d.mode === "approval_required") {
      approvalId = randomUUID();
      await c.query(`INSERT INTO approvals (id, clinic_id, requested_by, action_type, details, mode, status, agent_id, patient_id, summary)
                     VALUES ($1, rc_clinic_id(), 'nepa:whatsapp', 'send_whatsapp', $2, 'approval_required', 'pending', $3, $4, $5)`,
        [approvalId, { messageId: id, template: input.template, text: filled.text }, r.agent?.id ?? null, input.patientId,
         `WhatsApp ${p.name}: ${TEMPLATES[input.template].label.toLowerCase()}`]);
      await c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, approval_id, reason, urgency, is_simulated)
                     VALUES (rc_clinic_id(), 'pending_approval', $1, $2, $3, 3, $4) ON CONFLICT DO NOTHING`,
        [input.patientId, approvalId, `NEPA asks to send ${p.name} a WhatsApp message: ${TEMPLATES[input.template].label.toLowerCase()}`, !!input.simulated]);
    }
    const ins = await c.query(
      `INSERT INTO whatsapp_messages (id, clinic_id, patient_id, direction, template_key, language, body, status, peer_number, provider,
                                      appointment_id, workflow_id, approval_id, due_at, is_simulated)
       VALUES ($1, rc_clinic_id(), $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, now()), $13) ON CONFLICT DO NOTHING`,
      [id, input.patientId, input.template, lang, filled.text, approvalId ? "awaiting_approval" : "queued", toE164Digits(p.phone),
       wa.status === "connected" ? "meta_cloud" : "simulated", input.appointmentId ?? null, input.workflowId ?? null, approvalId, input.dueAt ?? null,
       !!input.simulated || wa.status === "simulated"]);
    return { messageId: ins.rowCount ? id : null, mode: d.mode, reason: d.reason };
  });
}

// ---------- sending ----------

/** Sends due messages for one clinic. Never between 9 pm and 9 am (same rule as calls). */
export async function runWhatsApp(clinicId: string, opts: { ignoreQuietHours?: boolean } = {}) {
  const hour = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  const sent: { id: string; status: string }[] = [];
  const due = await withContext(clinicCtx(clinicId), async (c) => {
    await c.query("SELECT rc_whatsapp_sync_approvals()");
    if (!opts.ignoreQuietHours && (hour < 9 || hour >= 21)) return [];
    const wa = (await c.query("SELECT * FROM clinic_whatsapp WHERE clinic_id = rc_clinic_id()")).rows[0];
    if (!wa || wa.status === "off") return [];
    const rows = (await c.query(
      `SELECT m.* FROM whatsapp_messages m WHERE m.status = 'queued' AND m.direction = 'out' AND m.due_at <= now() ORDER BY m.due_at LIMIT 50 FOR UPDATE SKIP LOCKED`)).rows;
    return rows.map((m) => ({ ...m, phone_number_id: wa.phone_number_id }));
  });
  for (const m of due) {
    try {
      // a patient may opt out between queueing and sending
      const status = await withContext(clinicCtx(clinicId), async (c) => {
        const p = (await c.query("SELECT * FROM rc_nepa_patient_brief($1)", [m.patient_id])).rows[0];
        const wp = p ? (await c.query("SELECT * FROM rc_whatsapp_patient($1)", [p.phone ?? ""])).rows[0] : null;
        return wp?.whatsapp_status ?? "unknown";
      });
      if (status !== "opted_in") {
        await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE whatsapp_messages SET status='cancelled', error='Patient is no longer opted in.' WHERE id=$1", [m.id]));
        sent.push({ id: m.id, status: "cancelled" });
        continue;
      }
      const tpl = m.template_key ? { name: m.template_key, language: m.language as Lang, params: [] } : null;
      // test-mode messages never reach a real provider, even once one is connected
      const provider = m.is_simulated && !getWhatsApp().info.simulated ? simulatedSink() : getWhatsApp();
      const r = await provider.send({ to: m.peer_number, phoneNumberId: m.phone_number_id, text: m.body, template: tpl });
      await withContext(clinicCtx(clinicId), (c) => c.query(
        "UPDATE whatsapp_messages SET status='sent', sent_at=now(), provider_message_id=$2 WHERE id=$1", [m.id, r.providerMessageId]));
      sent.push({ id: m.id, status: "sent" });
    } catch (e) {
      reportError(e, { where: "whatsapp send", clinic: clinicId });
      await withContext(clinicCtx(clinicId), async (c) => {
        await c.query("UPDATE whatsapp_messages SET status='failed', error=$2 WHERE id=$1", [m.id, (e as Error).message.slice(0, 300)]);
        await c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency, is_simulated) VALUES (rc_clinic_id(), 'whatsapp_reply', $1, $2, 2, $3) ON CONFLICT DO NOTHING`,
          [m.patient_id, `A WhatsApp message could not be sent: ${(e as Error).message.slice(0, 200)}`, m.is_simulated]);
      });
      sent.push({ id: m.id, status: "failed" });
    }
  }
  return sent;
}

// ---------- receiving ----------

const URGENT = /\b(bleed\w*|swell\w*|severe|unbearable|emergency|fever|faint\w*|can'?t breathe|pus|khoon|sujan|bahut dard|tez dard|ಊತ|ರಕ್ತ)\b|खून|सूजन|बहुत दर्द|दर्द/i;
const WORRY = /\b(pain|hurt\w*|problem|worse|dard|takleef|ನೋವು)\b|तकलीफ/i;
export function intentOf(text: string): "confirm" | "change" | "stop" | "start" | "urgent" | "worry" | "other" {
  const t = text.trim().toLowerCase();
  if (/^(stop|unsubscribe|बंद|ನಿಲ್ಲಿಸಿ)\b/.test(t)) return "stop";
  if (/^(start|subscribe)\b/.test(t)) return "start";
  if (URGENT.test(t)) return "urgent";
  if (/^(1|yes|ok|okay|confirm\w*|haan|ha|हाँ|हां|ಹೌದು)\W*$/.test(t)) return "confirm";
  if (/^(2|change|reschedule|no|nahi|नहीं|ಇಲ್ಲ)\W*$/.test(t)) return "change";
  if (WORRY.test(t)) return "worry";
  return "other";
}

/** Handles verified webhook events. Unknown numbers are ignored (logged), never stored against a patient. */
export async function receiveWhatsApp(events: WhatsAppEvent[], opts: { simulated?: boolean } = {}) {
  const out: { type: string; result: string }[] = [];
  for (const e of events) {
    if (e.type === "status") {
      // delivery receipts carry only the provider's message id; a definer function updates that one message
      const done = await updateStatus(e);
      out.push({ type: "status", result: done ? e.status : "unknown message" });
      continue;
    }
    const clinicId: string | null = await withoutUser(async (c) =>
      (await c.query("SELECT rc_whatsapp_clinic_for_number($1) AS id", [e.to])).rows[0].id);
    if (!clinicId) { out.push({ type: "message", result: "no clinic for number" }); continue; }
    out.push({ type: "message", result: await handleIncoming(clinicId, e, !!opts.simulated) });
  }
  return out;
}

async function updateStatus(e: Extract<WhatsAppEvent, { type: "status" }>) {
  return withoutUser(async (c) => {
    const r = await c.query("SELECT rc_whatsapp_status_update($1, $2, $3) AS ok", [e.providerMessageId, e.status, e.error ?? null]);
    return r.rows[0].ok as boolean;
  });
}

async function handleIncoming(clinicId: string, e: Extract<WhatsAppEvent, { type: "message" }>, simulated: boolean): Promise<string> {
  const followUp: (() => Promise<unknown>)[] = [];
  const result = await withContext(clinicCtx(clinicId), async (c) => {
    const wp = (await c.query("SELECT * FROM rc_whatsapp_patient($1)", [e.from])).rows[0] ?? null;
    const intent = intentOf(e.text);
    const ins = await c.query(
      `INSERT INTO whatsapp_messages (clinic_id, patient_id, direction, body, status, peer_number, provider, provider_message_id, intent, is_simulated, created_at)
       VALUES (rc_clinic_id(), $1, 'in', $2, 'received', $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING id`,
      [wp?.id ?? null, e.text.slice(0, 4000), digits(e.from), simulated ? "simulated" : "meta_cloud", e.providerMessageId, intent, simulated, e.at]);
    if (!ins.rowCount) return "duplicate";
    const msgId = ins.rows[0].id as string;
    if (!wp) {
      await attention(c, null, `WhatsApp from an unknown number (${digits(e.from).slice(-10)}): “${e.text.slice(0, 160)}”`, 2, simulated);
      return "unknown sender: told staff";
    }
    const handled = (note: string) => c.query("UPDATE whatsapp_messages SET handled_at = now(), error = $2 WHERE id = $1", [msgId, note]);
    if (intent === "stop") {
      await c.query("SELECT rc_whatsapp_set_status($1, 'opted_out', 'patient')", [wp.id]);
      await handled("Patient opted out.");
      return "opted out";
    }
    if (intent === "start") {
      await c.query("SELECT rc_whatsapp_set_status($1, 'opted_in', 'patient')", [wp.id]);
      await handled("Patient opted in.");
      return "opted in";
    }
    // what was the last message we sent them (within 3 days)?
    const last = (await c.query(
      `SELECT template_key, appointment_id FROM whatsapp_messages WHERE patient_id = $1 AND direction = 'out' AND status IN ('sent','delivered','read')
        AND sent_at > now() - interval '3 days' ORDER BY sent_at DESC LIMIT 1`, [wp.id])).rows[0];
    if (intent === "urgent") {
      await attention(c, wp.id, `Urgent WhatsApp from ${wp.name}: “${e.text.slice(0, 200)}”. Call the patient now.`, 1, simulated);
      return "urgent: told staff";
    }
    if (intent === "confirm" && last?.template_key === "appointment_confirmation" && last.appointment_id) {
      const ok = (await c.query("SELECT rc_whatsapp_confirm_appointment($1) AS ok", [last.appointment_id])).rows[0].ok;
      if (ok) { await handled("Appointment confirmed from the reply."); return "appointment confirmed"; }
    }
    if (intent === "change" && last?.template_key === "appointment_confirmation" && last.appointment_id) {
      await c.query(
        `INSERT INTO attention_items (clinic_id, kind, patient_id, appointment_id, reason, urgency, is_simulated)
         VALUES (rc_clinic_id(), 'reschedule_request', $1, $2, $3, 2, $4) ON CONFLICT DO NOTHING`,
        [wp.id, last.appointment_id, `${wp.name} replied on WhatsApp that they need to change their appointment.`, simulated]);
      return "change request: told staff";
    }
    if (intent === "confirm" && ["no_show_location", "next_visit", "lead_welcome"].includes(last?.template_key ?? "")) {
      followUp.push(() => queueOutbound(clinicId, { patientId: wp.id, purpose: last.template_key === "no_show_location" ? "no_show_followup" : "follow_up",
        agentKind: "lead_followup", simulated, summary: `Booking call requested on WhatsApp by ${wp.name}` }));
      await handled("Patient asked to book: NEPA call queued.");
      return "booking call queued";
    }
    await attention(c, wp.id, `WhatsApp from ${wp.name}: “${e.text.slice(0, 200)}”`, intent === "worry" ? 1 : 3, simulated);
    return intent === "worry" ? "worrying reply: told staff" : "reply: told staff";
  });
  for (const f of followUp) await f().catch((err) => reportError(err, { where: "whatsapp follow-up", clinic: clinicId }));
  return result;
}

const attention = (c: PoolClient, patientId: string | null, reason: string, urgency: number, simulated: boolean) =>
  c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency, is_simulated)
           VALUES (rc_clinic_id(), 'whatsapp_reply', $1, $2, $3, $4) ON CONFLICT DO NOTHING`, [patientId, reason, urgency, simulated]);

// ---------- staff: conversations and replies ----------

export async function listConversations(actor: SignedInUser, opts: { unhandledOnly?: boolean } = {}) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patients");
    const r = await c.query(
      `SELECT DISTINCT ON (m.patient_id) m.patient_id, p.name, p.patient_code, m.body, m.direction, m.created_at, m.is_simulated,
              (SELECT count(*) FROM whatsapp_messages x WHERE x.patient_id = m.patient_id AND x.direction = 'in' AND x.handled_at IS NULL)::int AS unhandled
         FROM whatsapp_messages m JOIN patients p ON p.id = m.patient_id
        WHERE m.patient_id IS NOT NULL AND m.status NOT IN ('skipped','cancelled')
        ORDER BY m.patient_id, m.created_at DESC`);
    const rows = r.rows
      .map((x) => ({ patientId: x.patient_id as string, name: x.name as string, code: x.patient_code as string, last: x.body as string, direction: x.direction as "in" | "out",
        at: x.created_at as Date, simulated: x.is_simulated as boolean, unhandled: x.unhandled as number }))
      .filter((x) => !opts.unhandledOnly || x.unhandled > 0)
      .sort((a, b) => (b.unhandled > 0 ? 1 : 0) - (a.unhandled > 0 ? 1 : 0) || +b.at - +a.at);
    return rows.slice(0, 200);
  });
}

export async function conversation(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patients");
    if (!z.string().uuid().safeParse(patientId).success) throw new UserError("Patient not found.");
    const p = (await c.query("SELECT id, name, patient_code, phone, whatsapp_status, preferred_language FROM patients WHERE id = $1", [patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    const msgs = (await c.query(
      `SELECT m.*, u.display_name AS sender FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.sent_by
        WHERE m.patient_id = $1 ORDER BY m.created_at DESC LIMIT 100`, [patientId])).rows.reverse();
    const lastIn = [...msgs].reverse().find((m) => m.direction === "in");
    const windowOpen = !!lastIn && Date.now() - new Date(lastIn.created_at).getTime() < 24 * 3600_000;
    return {
      patient: { id: p.id, name: p.name, code: p.patient_code, phone: p.phone, whatsapp: p.whatsapp_status as string, language: p.preferred_language as string | null },
      windowOpen,
      messages: msgs.map((m) => ({ id: m.id, direction: m.direction as "in" | "out", body: m.body, status: m.status, template: m.template_key as TemplateKey | null,
        at: m.created_at as Date, sentAt: m.sent_at as Date | null, sender: m.sender as string | null, error: m.error as string | null,
        intent: m.intent as string | null, handledAt: m.handled_at as Date | null, simulated: m.is_simulated as boolean })),
    };
  });
}

/** Free-text reply from staff. WhatsApp allows it only within 24 hours of the patient's last message. */
export async function staffReply(actor: SignedInUser, patientId: string, text: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_attention", "You need permission to handle patient messages.");
    const body = text.trim();
    if (body.length < 1 || body.length > 1000) throw new UserError("Write a message (up to 1,000 characters).", "text");
    const p = (await c.query("SELECT id, phone, whatsapp_status FROM patients WHERE id = $1 AND merged_into IS NULL", [patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    if (p.whatsapp_status === "opted_out") throw new UserError("This patient asked not to get WhatsApp messages.");
    const lastIn = (await c.query("SELECT created_at FROM whatsapp_messages WHERE patient_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1", [patientId])).rows[0];
    if (!lastIn || Date.now() - new Date(lastIn.created_at).getTime() > 24 * 3600_000) {
      throw new UserError("WhatsApp only allows a free reply within 24 hours of the patient's last message. Call the patient instead.");
    }
    const wa = (await c.query("SELECT * FROM clinic_whatsapp WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    if (!wa || wa.status === "off") throw new UserError("WhatsApp is not connected for this clinic.");
    const id = randomUUID();
    await c.query(
      `INSERT INTO whatsapp_messages (id, clinic_id, patient_id, direction, body, status, peer_number, provider, sent_by, is_simulated)
       VALUES ($1,$2,$3,'out',$4,'queued',$5,$6,$7,$8)`,
      [id, actor.clinicId, patientId, body, toE164Digits(p.phone), wa.status === "connected" ? "meta_cloud" : "simulated", actor.userId, wa.status === "simulated"]);
    // replies are part of a live conversation: handled now, and the patient's messages are marked handled
    await c.query("UPDATE whatsapp_messages SET handled_at = now() WHERE patient_id = $1 AND direction = 'in' AND handled_at IS NULL", [patientId]);
    await audit(c, actor, "whatsapp_reply_sent", "patient", patientId);
    return id;
  }).then(async (r) => {
    if (r.ok) await runWhatsApp(actor.clinicId!, { ignoreQuietHours: true }).catch((e) => reportError(e, { where: "whatsapp reply send" }));
    return r;
  });
}

export async function markHandled(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_attention");
    await c.query("UPDATE whatsapp_messages SET handled_at = now() WHERE patient_id = $1 AND direction = 'in' AND handled_at IS NULL", [patientId]);
    return true;
  });
}

export { TEMPLATE_KEYS, TEMPLATES };
