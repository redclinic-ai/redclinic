// Needs Attention: what staff must look at. Urgent first, then oldest. Resolved items leave the list but stay searchable.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, UserError } from "../authz";

export const KIND_LABEL: Record<string, string> = {
  call_not_completed: "Call not completed", call_handed_over: "Caller needs staff", unanswered_question: "Unanswered question",
  complaint: "Complaint", reschedule_request: "Wants to reschedule", cancellation_request: "Wants to cancel",
  unconfirmed_appointment: "Not confirmed", no_show_no_rebooking: "No-show, not rebooked", failed_outbound_call: "Call didn't go through",
  pending_approval: "Waiting for approval", failed_workflow: "Workflow failed", consent_withdrawn: "Consent withdrawn",
};

/** What the main button does for each kind. */
export const NEXT_ACTION: Record<string, string> = {
  call_not_completed: "Call back", call_handed_over: "Call back", unanswered_question: "Call back", complaint: "Call back",
  reschedule_request: "Reschedule", cancellation_request: "Cancel appointment", unconfirmed_appointment: "Call to confirm",
  no_show_no_rebooking: "Call to rebook", failed_outbound_call: "Call back", pending_approval: "Review", failed_workflow: "Review",
  consent_withdrawn: "Review",
};

export interface AttentionItem {
  id: string; kind: string; label: string; nextAction: string; reason: string; urgency: number; status: string;
  createdAt: Date; patientId: string | null; patientName: string | null; patientCode: string | null; patientPhone: string | null;
  appointmentId: string | null; callId: string | null; approvalId: string | null; isSimulated: boolean;
  assignedTo: string | null; assignedToName: string | null; snoozedUntil: Date | null; resolvedAt: Date | null; resolvedByName: string | null; resolution: string | null;
}

const SELECT = `
  SELECT i.*, p.name AS patient_name, p.patient_code, p.phone AS patient_phone, au.display_name AS assigned_name, ru.display_name AS resolved_name
  FROM attention_items i
  LEFT JOIN patients p ON p.id = i.patient_id
  LEFT JOIN users au ON au.id = i.assigned_to
  LEFT JOIN users ru ON ru.id = i.resolved_by`;

function toItem(x: Record<string, any>): AttentionItem {
  return {
    id: x.id, kind: x.kind, label: KIND_LABEL[x.kind] ?? x.kind, nextAction: NEXT_ACTION[x.kind] ?? "Review", reason: x.reason,
    urgency: x.urgency, status: x.status, createdAt: x.created_at, patientId: x.patient_id, patientName: x.patient_name,
    patientCode: x.patient_code, patientPhone: x.patient_phone, appointmentId: x.appointment_id, callId: x.call_id,
    approvalId: x.approval_id, isSimulated: x.is_simulated, assignedTo: x.assigned_to, assignedToName: x.assigned_name,
    snoozedUntil: x.snoozed_until, resolvedAt: x.resolved_at, resolvedByName: x.resolved_name, resolution: x.resolution,
  };
}

export interface AttentionFilter { view?: "active" | "resolved" | "snoozed"; mine?: boolean; q?: string; includeSimulated?: boolean; limit?: number }

export async function listAttention(actor: SignedInUser, f: AttentionFilter = {}) {
  return act(actor, async (c) => {
    if (!(await can(c, "manage_attention")) && !(await can(c, "view_approvals"))) throw new UserError("You don't have access to Needs attention.");
    await c.query("SELECT rc_refresh_attention()");
    const where: string[] = [];
    const args: unknown[] = [];
    const view = f.view ?? "active";
    where.push(view === "active" ? "i.status = 'open'" : view === "snoozed" ? "i.status = 'snoozed'" : "i.status = 'resolved'");
    if (!f.includeSimulated) where.push("NOT i.is_simulated");
    if (f.mine) { args.push(actor.userId); where.push(`i.assigned_to = $${args.length}`); }
    if (f.q?.trim()) { args.push(f.q.trim()); where.push(`(p.name ILIKE '%' || $${args.length} || '%' OR i.reason ILIKE '%' || $${args.length} || '%' OR p.patient_code ILIKE $${args.length})`); }
    args.push(Math.min(f.limit ?? 100, 300));
    const order = view === "resolved" ? "i.resolved_at DESC" : "i.urgency, i.created_at";
    const r = await c.query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT $${args.length}`, args);
    const counts = (await c.query(
      `SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE status='open' AND urgency=1)::int AS urgent,
              count(*) FILTER (WHERE status='snoozed')::int AS snoozed FROM attention_items WHERE ${f.includeSimulated ? "true" : "NOT is_simulated"}`,
    )).rows[0];
    return { items: r.rows.map(toItem), counts: counts as { open: number; urgent: number; snoozed: number } };
  });
}

async function change(actor: SignedInUser, id: string, fn: (c: import("pg").PoolClient) => Promise<void>, action: string, detail: object = {}) {
  return act(actor, async (c) => {
    if (!z.string().uuid().safeParse(id).success) throw new UserError("Item not found.");
    if (!(await can(c, "manage_attention"))) throw new UserError("You don't have permission to work on this list.");
    const exists = (await c.query("SELECT status FROM attention_items WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!exists) throw new UserError("Item not found.");
    await fn(c);
    await audit(c, actor, action, "attention_item", id, detail);
    return null;
  });
}

export const resolveAttention = (actor: SignedInUser, id: string, note?: string) =>
  change(actor, id, async (c) => {
    await c.query("UPDATE attention_items SET status='resolved', resolved_by=$2, resolved_at=now(), resolution=$3, updated_at=now() WHERE id=$1",
      [id, actor.userId, note?.trim().slice(0, 500) || "Done"]);
  }, "attention_resolved", { note });

export const reopenAttention = (actor: SignedInUser, id: string) =>
  change(actor, id, async (c) => {
    await c.query("UPDATE attention_items SET status='open', resolved_by=NULL, resolved_at=NULL, resolution=NULL, updated_at=now() WHERE id=$1", [id]);
  }, "attention_reopened");

export function snoozeUntil(choice: string, now = new Date()): Date | null {
  const h = { "1h": 1, "3h": 3, tomorrow: 0 }[choice as "1h"];
  if (choice === "tomorrow") {
    const ist = new Date(now.getTime() + 5.5 * 3600_000);
    ist.setUTCDate(ist.getUTCDate() + 1); ist.setUTCHours(9, 0, 0, 0);
    return new Date(ist.getTime() - 5.5 * 3600_000); // 9 am IST tomorrow
  }
  return h ? new Date(now.getTime() + h * 3600_000) : null;
}

export const snoozeAttention = (actor: SignedInUser, id: string, choice: string) => {
  const until = snoozeUntil(choice);
  if (!until) return Promise.resolve({ ok: false as const, error: "Choose how long to snooze." });
  return change(actor, id, async (c) => {
    await c.query("UPDATE attention_items SET status='snoozed', snoozed_until=$2, updated_at=now() WHERE id=$1", [id, until]);
  }, "attention_snoozed", { until });
};

export const assignAttention = (actor: SignedInUser, id: string, userId: string | null) =>
  change(actor, id, async (c) => {
    if (userId) {
      const u = (await c.query("SELECT 1 FROM users WHERE id=$1 AND status='active'", [userId])).rowCount;
      if (!u) throw new UserError("Choose a staff member.");
    }
    await c.query("UPDATE attention_items SET assigned_to=$2, updated_at=now() WHERE id=$1", [id, userId]);
  }, "attention_assigned", { to: userId });

/** Staff (and only staff) create items by hand, e.g. a complaint at the desk. */
export async function addAttention(actor: SignedInUser, input: { kind: string; reason: string; patientId?: string; urgency?: number }) {
  return act(actor, async (c) => {
    if (!(await can(c, "manage_attention"))) throw new UserError("You don't have permission to add items.");
    if (!["complaint", "unanswered_question", "reschedule_request", "cancellation_request"].includes(input.kind)) throw new UserError("Choose a type.");
    if (input.reason.trim().length < 3) throw new UserError("Say what needs doing.", "reason");
    const r = await c.query(
      "INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [actor.clinicId, input.kind, input.patientId || null, input.reason.trim().slice(0, 500), input.urgency === 1 ? 1 : 2],
    );
    await audit(c, actor, "attention_added", "attention_item", r.rows[0].id);
    return r.rows[0].id as string;
  });
}
