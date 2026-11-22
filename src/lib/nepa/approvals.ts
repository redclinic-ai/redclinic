// Approval queue: NEPA prepares, an authorised person decides. Approving runs the action as that person
// (so their own permissions apply too) and records whether it worked.
import type { PoolClient } from "pg";
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, UserError } from "../authz";
import { ACTIONS, type Action } from "./permissions";

export interface Approval {
  id: string; action: Action; actionLabel: string; mode: string; status: string; summary: string | null; details: Record<string, any>;
  requestedBy: string; isTest: boolean; patientId: string | null; patientName: string | null; callId: string | null; createdAt: Date;
  decidedBy: string | null; decidedAt: Date | null; failure: string | null; result: Record<string, any> | null; note: string | null;
}

export async function listApprovals(actor: SignedInUser, view: "pending" | "decided" = "pending") {
  return act(actor, async (c) => {
    if (!(await can(c, "view_approvals")) && !(await can(c, "approve_actions"))) throw new UserError("You don't have access to approvals.");
    const r = await c.query(
      `SELECT a.*, p.name AS patient_name, u.display_name AS decided_name, coalesce(cl.is_simulated, false) AS is_test FROM approvals a
       LEFT JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = a.decided_by LEFT JOIN calls cl ON cl.id = a.call_id
       WHERE ${view === "pending" ? "a.status = 'pending'" : "a.status <> 'pending'"}
       ORDER BY ${view === "pending" ? "a.created_at" : "coalesce(a.decided_at, a.created_at) DESC"} LIMIT 200`);
    return r.rows.map((x): Approval => ({
      id: x.id, action: x.action_type, actionLabel: ACTIONS[x.action_type as Action]?.label ?? x.action_type, mode: x.mode, status: x.status,
      summary: x.summary, details: x.details, requestedBy: x.requested_by, isTest: x.is_test, patientId: x.patient_id, patientName: x.patient_name, callId: x.call_id,
      createdAt: x.created_at, decidedBy: x.decided_name, decidedAt: x.decided_at, failure: x.failure_detail, result: x.result, note: x.decision_note,
    }));
  });
}

async function execute(c: PoolClient, actor: SignedInUser, a: Record<string, any>, input: { date?: string; time?: string }) {
  const d = a.details ?? {};
  switch (a.action_type as Action) {
    case "book_appointment": {
      if (!(await can(c, "manage_appointments"))) throw new UserError("You also need permission to book appointments.");
      const r = await c.query(
        `INSERT INTO appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, reason, booked_via, source_call_id, created_by)
         VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6::int),'scheduled',$7,'nepa',$8,$9) RETURNING id`,
        [actor.clinicId, d.patientId, d.doctorId, d.serviceId ?? null, d.start, d.minutes ?? 30, d.reason ?? null, a.call_id, actor.userId]);
      return { appointmentId: r.rows[0].id };
    }
    case "cancel_appointment":
    case "send_reminder": {
      if (d.appointmentId && d.to) {
        if (!(await can(c, "manage_appointments"))) throw new UserError("You also need permission to manage appointments.");
        const r = await c.query("UPDATE appointments SET status=$2, cancel_reason=$3, updated_at=now() WHERE id=$1 AND status IN ('scheduled','confirmed') RETURNING id",
          [d.appointmentId, d.to, d.to === "cancelled" ? (d.reason || "Cancelled by patient on call") : null]);
        if (!r.rowCount) throw new UserError("That appointment is no longer upcoming.");
        return { appointmentId: d.appointmentId, status: d.to };
      }
      return { queued: true }; // an outgoing reminder call: the dialler picks up approved calls
    }
    case "outbound_call":
      return { queued: true };
    case "reschedule_appointment": {
      if (!input.date || !input.time) throw new UserError("Choose the new date and time to approve this.", "date");
      const { rescheduleAppointment } = await import("../appointments/service");
      // runs in its own transaction as the same user; the approval row is updated after it succeeds
      const r = await rescheduleAppointment(actor, d.appointmentId, { date: input.date, time: input.time });
      if (!r.ok) throw new UserError(r.error, r.field);
      return { appointmentId: r.value, movedFrom: d.appointmentId };
    }
    case "update_patient": {
      const allowed = ["name", "phone", "email", "address"];
      const changes = Object.fromEntries(Object.entries(d.changes ?? {}).filter(([k]) => allowed.includes(k)));
      if (!Object.keys(changes).length) throw new UserError("Nothing to change.");
      const sets = Object.keys(changes).map((k, i) => `${k} = $${i + 2}`).join(", ");
      const r = await c.query(`UPDATE patients SET ${sets} WHERE id = $1 RETURNING id`, [d.patientId, ...Object.values(changes)]);
      if (!r.rowCount) throw new UserError("You don't have permission to change this patient.");
      return { patientId: d.patientId, changed: Object.keys(changes) };
    }
    case "draft_note": {
      const r = await c.query(
        `INSERT INTO patient_clinical (patient_id, clinic_id, notes) VALUES ($1,$2,$3)
         ON CONFLICT (patient_id) DO UPDATE SET notes = concat_ws(E'\n\n', patient_clinical.notes, EXCLUDED.notes), updated_at = now() RETURNING patient_id`,
        [d.patientId, actor.clinicId, String(d.note ?? "").slice(0, 5000)]);
      if (!r.rowCount) throw new UserError("You don't have permission to add notes.");
      return { patientId: d.patientId };
    }
    default:
      throw new UserError("This kind of action can't be approved here.");
  }
}

export type DecisionOutcome = { status: "rejected" } | { status: "executed"; result: unknown } | { status: "failed"; error: string };

export async function decideApproval(actor: SignedInUser, id: string, decision: "approve" | "reject", input: { note?: string; date?: string; time?: string } = {}): Promise<import("../auth/service").Result<DecisionOutcome>> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false as const, error: "Approval not found." };
  // a reschedule runs in its own transaction; validate first, then record
  const res = await act(actor, async (c) => {
    if (!(await can(c, "approve_actions"))) throw new UserError("You don't have permission to approve NEPA's actions.");
    const a = (await c.query("SELECT * FROM approvals WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!a) throw new UserError("Approval not found.");
    if (a.status !== "pending") throw new UserError("This has already been decided.");
    if (decision === "reject") {
      await c.query("UPDATE approvals SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1", [id, actor.userId, input.note?.slice(0, 500) || null]);
      await c.query("UPDATE attention_items SET status='resolved', resolved_by=$2, resolved_at=now(), resolution='Rejected', updated_at=now() WHERE approval_id=$1 AND status<>'resolved'", [id, actor.userId]);
      await audit(c, actor, "approval_rejected", "approval", id);
      return { status: "rejected" as const };
    }
    await c.query("UPDATE approvals SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1", [id, actor.userId, input.note?.slice(0, 500) || null]);
    await audit(c, actor, "approval_approved", "approval", id, { action: a.action_type });
    return { status: "approved" as const, row: a };
  });
  if (!res.ok) return res;
  if (res.value.status === "rejected") return { ok: true, value: { status: "rejected" } };
  // execute, then record the outcome (a failure is kept, never hidden)
  const row = res.value.row;
  const exec = await act(actor, async (c) => {
    try {
      await c.query("SAVEPOINT exec");
      const result = await execute(c, actor, row, input);
      await c.query("UPDATE approvals SET status='executed', executed_at=now(), result=$2 WHERE id=$1", [id, result]);
      await c.query("UPDATE attention_items SET status='resolved', resolved_by=$2, resolved_at=now(), resolution='Approved and done', updated_at=now() WHERE approval_id=$1 AND status<>'resolved'", [id, actor.userId]);
      await audit(c, actor, "approval_executed", "approval", id, result);
      return { status: "executed" as const, result };
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT exec");
      const message = e instanceof UserError ? e.message : (e as { code?: string }).code === "23P01" ? "That time is no longer free." : (e as Error).message;
      if (e instanceof UserError && e.field === "date") {
        // missing input: put it back to pending so the person can try again
        await c.query("UPDATE approvals SET status='pending', decided_by=NULL, decided_at=NULL WHERE id=$1", [id]);
        throw e;
      }
      await c.query("UPDATE approvals SET status='failed', failure_detail=$2 WHERE id=$1", [id, message]);
      await c.query(
        `INSERT INTO attention_items (clinic_id, kind, approval_id, patient_id, reason, urgency) VALUES ($1,'failed_workflow',$2,$3,$4,2) ON CONFLICT DO NOTHING`,
        [actor.clinicId, id, row.patient_id, `Approved action failed: ${message}`]);
      await audit(c, actor, "approval_failed", "approval", id, { error: message });
      return { status: "failed" as const, error: message };
    }
  });
  return exec;
}
