// The only things NEPA can do. Each tool is narrow, runs inside one clinic, and asks the permission engine first.
// No tool accepts SQL or table names. Results say exactly what happened, so NEPA never claims an unconfirmed action.
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { decide, type Action, type Mode } from "./permissions";
import type { Resolved } from "./resolver";

export interface ToolContext { c: PoolClient; r: Resolved; callId: string | null; simulated: boolean }

export type ActionOutcome =
  | { status: "done"; mode: "automatic"; detail: Record<string, unknown> }
  | { status: "awaiting_approval"; mode: "approval_required"; approvalId: string }
  | { status: "suggested"; mode: "suggest"; approvalId: string }
  | { status: "not_allowed"; mode: "prohibited"; reason: string }
  | { status: "failed"; mode: Mode; reason: string };

// ---------- read-only ----------
const words = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["the", "you", "your", "are", "for", "and", "can", "what", "how", "is", "do", "does", "have", "any", "there", "please", "tell", "about", "with", "this", "that", "clinic", "kya", "hai", "aap", "mujhe"]);

/** Best approved answer for a question, or null. Never generates an answer. */
export function answerFaq(r: Resolved, question: string, lang?: string) {
  if (r.agentConfig?.knowledgeScope === "none") return null;
  const q = new Set(words(question));
  if (!q.size) return null;
  let best: { score: number; faq: Resolved["knowledge"]["faqs"][number] } | null = null;
  for (const f of r.knowledge.faqs) {
    const fw = words(f.question);
    const overlap = fw.filter((w) => q.has(w) || [...q].some((x) => x.length > 4 && (w.startsWith(x.slice(0, 5)) || x.startsWith(w.slice(0, 5))))).length;
    const score = overlap / Math.max(2, Math.min(fw.length, q.size)) + (lang && f.language === lang ? 0.05 : 0);
    if (overlap >= 1 && (!best || score > best.score)) best = { score, faq: f };
  }
  return best && best.score >= 0.5 ? { faqId: best.faq.id, answer: best.faq.answer, question: best.faq.question } : null;
}

export async function findCaller(t: ToolContext, phone: string) {
  const r = await t.c.query("SELECT * FROM rc_nepa_find_caller($1)", [phone]);
  if (r.rowCount !== 1) return null; // none, or more than one: never guess who it is
  const x = r.rows[0];
  return { patientId: x.patient_id as string, name: x.name as string, consent: x.consent_status as "given", nextAppointmentId: x.next_appointment as string | null, nextAt: x.next_at as Date | null };
}

/** Free slots for a local date from opening hours minus booked times. Returns nothing if hours are not set (never invents). */
export async function freeSlots(t: ToolContext, date: string, minutes = 30, doctorId?: string) {
  const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(date + "T12:00:00Z").getUTCDay()];
  const hours = t.r.knowledge.clinic.workingHours[day];
  if (!hours) return [];
  const tz = t.r.knowledge.clinic.timezone;
  const bounds = (await t.c.query("SELECT ($1::date + $2::time) AT TIME ZONE $4 AS o, ($1::date + $3::time) AT TIME ZONE $4 AS c", [date, hours.open, hours.close, tz])).rows[0];
  const busy = (await t.c.query("SELECT * FROM rc_nepa_busy($1,$2)", [bounds.o, bounds.c])).rows;
  const doctors = doctorId ? t.r.knowledge.doctors.filter((d) => d.id === doctorId) : t.r.knowledge.doctors;
  const slots: { doctorId: string; doctorName: string; start: Date }[] = [];
  for (let s = new Date(bounds.o).getTime(); s + minutes * 60_000 <= new Date(bounds.c).getTime(); s += 30 * 60_000) {
    if (s < Date.now() + 30 * 60_000) continue;
    for (const d of doctors) {
      const clash = busy.some((b) => b.doctor_id === d.id && new Date(b.starts_at).getTime() < s + minutes * 60_000 && new Date(b.ends_at).getTime() > s);
      if (!clash) { slots.push({ doctorId: d.id, doctorName: d.name, start: new Date(s) }); break; }
    }
  }
  return slots;
}

// ---------- actions (go through the permission engine) ----------
async function workflowFor(t: ToolContext, workflowId?: string | null) {
  if (!workflowId) return null;
  const w = (await t.c.query("SELECT id, enabled, automatic_enabled FROM clinic_workflows WHERE id = $1", [workflowId])).rows[0];
  return w ? { id: w.id, enabled: w.enabled, automaticEnabled: w.automatic_enabled } : null;
}

async function queueApproval(t: ToolContext, action: Action, mode: "approval_required" | "suggest", details: Record<string, unknown>, summary: string, patientId?: string | null) {
  // the id is made here: during a call NEPA has no user, so it may write an approval but not read approvals back
  const id = randomUUID();
  await t.c.query(
    `INSERT INTO approvals (id, clinic_id, requested_by, action_type, details, mode, status, agent_id, call_id, patient_id, summary)
     VALUES ($9, rc_clinic_id(), $1, $2, $3, $4, 'pending', $5, $6, $7, $8)`,
    [`nepa:${t.r.agent?.kind ?? "assistant"}`, action, details, mode, t.r.agent?.id ?? null, t.callId, patientId ?? null, summary, id]);
  await t.c.query(
    `INSERT INTO attention_items (clinic_id, kind, patient_id, call_id, approval_id, reason, urgency, is_simulated)
     VALUES (rc_clinic_id(), 'pending_approval', $1, $2, $3, $4, 2, $5) ON CONFLICT DO NOTHING`,
    [patientId ?? null, t.callId, id, `${mode === "suggest" ? "Suggested by NEPA" : "NEPA asks for approval"}: ${summary}`, t.simulated]);
  return id;
}

export interface BookRequest { patientId: string; doctorId: string; start: Date; minutes: number; reason: string | null; serviceId?: string | null }

export async function requestBooking(t: ToolContext, req: BookRequest): Promise<ActionOutcome> {
  const d = decide("book_appointment", { clinic: t.r.clinicConfig.permissions, agent: t.r.agentConfig?.permissions });
  const when = req.start.toLocaleString("en-IN", { timeZone: t.r.knowledge.clinic.timezone, dateStyle: "medium", timeStyle: "short" });
  const summary = `Book ${when}${req.reason ? ` for ${req.reason}` : ""}`;
  if (d.mode === "prohibited") return { status: "not_allowed", mode: "prohibited", reason: d.reason };
  if (d.mode !== "automatic") {
    const id = await queueApproval(t, "book_appointment", d.mode, { ...req, start: req.start.toISOString() }, summary, req.patientId);
    return d.mode === "suggest" ? { status: "suggested", mode: "suggest", approvalId: id } : { status: "awaiting_approval", mode: "approval_required", approvalId: id };
  }
  try {
    await t.c.query("SAVEPOINT nepa_book");
    const r = await t.c.query("SELECT rc_nepa_book($1,$2,$3,$4,$5,$6,$7) AS id", [req.patientId, req.doctorId, req.start, req.minutes, req.reason, t.callId, req.serviceId ?? null]);
    await t.c.query("RELEASE SAVEPOINT nepa_book");
    return { status: "done", mode: "automatic", detail: { appointmentId: r.rows[0].id, start: req.start.toISOString() } };
  } catch (e) {
    await t.c.query("ROLLBACK TO SAVEPOINT nepa_book");
    const code = (e as { code?: string }).code;
    return { status: "failed", mode: "automatic", reason: code === "23P01" ? "That time was just taken." : (e as Error).message };
  }
}

export async function requestStatusChange(t: ToolContext, appointmentId: string, to: "confirmed" | "cancelled", patientId: string | null, reason?: string): Promise<ActionOutcome> {
  // confirming is part of a reminder; cancelling is its own permission
  const action: Action = to === "cancelled" ? "cancel_appointment" : "send_reminder";
  const d = to === "cancelled"
    ? decide(action, { clinic: t.r.clinicConfig.permissions, agent: t.r.agentConfig?.permissions })
    : { mode: "automatic" as Mode, reason: "A patient confirming their own appointment is always recorded." };
  if (d.mode === "prohibited") return { status: "not_allowed", mode: "prohibited", reason: d.reason };
  if (d.mode !== "automatic") {
    const id = await queueApproval(t, action, d.mode as "approval_required", { appointmentId, to, reason }, `${to === "cancelled" ? "Cancel" : "Confirm"} appointment${reason ? ` (${reason})` : ""}`, patientId);
    return d.mode === "suggest" ? { status: "suggested", mode: "suggest", approvalId: id } : { status: "awaiting_approval", mode: "approval_required", approvalId: id };
  }
  try {
    await t.c.query("SAVEPOINT nepa_status");
    await t.c.query("SELECT rc_nepa_set_status($1,$2,$3,$4)", [appointmentId, to, reason ?? null, t.callId]);
    await t.c.query("RELEASE SAVEPOINT nepa_status");
    return { status: "done", mode: "automatic", detail: { appointmentId, status: to } };
  } catch (e) {
    await t.c.query("ROLLBACK TO SAVEPOINT nepa_status");
    return { status: "failed", mode: "automatic", reason: (e as Error).message };
  }
}

export async function requestReschedule(t: ToolContext, appointmentId: string, patientId: string | null, wish: string): Promise<ActionOutcome> {
  const d = decide("reschedule_appointment", { clinic: t.r.clinicConfig.permissions, agent: t.r.agentConfig?.permissions });
  if (d.mode === "prohibited") return { status: "not_allowed", mode: "prohibited", reason: d.reason };
  // V1: NEPA collects the wish; staff (or approval) choose the new slot
  const mode = d.mode === "automatic" ? "approval_required" : d.mode;
  const id = await queueApproval(t, "reschedule_appointment", mode, { appointmentId, wish }, `Move appointment: patient asks for ${wish || "another time"}`, patientId);
  return mode === "suggest" ? { status: "suggested", mode: "suggest", approvalId: id } : { status: "awaiting_approval", mode: "approval_required", approvalId: id };
}

export async function decideOutbound(t: ToolContext, kind: "outbound_call" | "send_reminder", workflowId: string | null, consent: "given" | "withdrawn" | "not_recorded") {
  return decide(kind, { clinic: t.r.clinicConfig.permissions, agent: t.r.agentConfig?.permissions, workflow: await workflowFor(t, workflowId), consent });
}

/** Hand the caller to staff: creates a Needs Attention item. Always allowed. */
export async function handToStaff(t: ToolContext, kind: "call_handed_over" | "call_not_completed" | "unanswered_question" | "complaint" | "reschedule_request" | "cancellation_request", reason: string, urgency: 1 | 2, patientId: string | null) {
  await t.c.query(
    `INSERT INTO attention_items (clinic_id, kind, patient_id, call_id, reason, urgency, is_simulated) VALUES (rc_clinic_id(), $1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`, [kind, patientId, t.callId, reason.slice(0, 500), urgency, t.simulated]);
}
