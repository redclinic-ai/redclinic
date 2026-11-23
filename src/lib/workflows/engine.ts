// Workflow engine. Runs every minute with the dialler. For each enabled workflow (format 2) it finds new subjects,
// schedules steps, and when a step is due checks its condition and either queues a call (through the permission
// engine: approval or automatic) or tells staff. It never contacts a patient directly.
import type { PoolClient } from "pg";
import { withContext, type DbContext } from "../db";
import { queueOutbound } from "../calls/service";
import { AGENT_FOR, definitionSchema, type Definition } from "./definition";

const clinicCtx = (clinicId: string): DbContext => ({ userId: null, clinicId, isSuperAdmin: false });
const LOOKBACK = "2 days";

function matchesService(def: Definition, service: string | null) {
  const m = def.trigger.serviceMatch;
  if (!m?.length) return true;
  const s = (service ?? "").toLowerCase();
  return m.some((x) => s.includes(x.toLowerCase()));
}

function dueAt(step: Definition["steps"][number], anchor: Date) {
  return step.beforeAppointmentMinutes !== undefined ? new Date(anchor.getTime() - step.beforeAppointmentMinutes * 60_000) : new Date(anchor.getTime() + (step.afterMinutes ?? 0) * 60_000);
}

/** Finds new subjects for each workflow and creates runs. Returns how many runs were created. */
async function discover(c: PoolClient) {
  const wfs = (await c.query("SELECT id, steps, version FROM clinic_workflows WHERE enabled AND step_format = 2")).rows;
  let created = 0;
  for (const w of wfs) {
    const parsed = definitionSchema.safeParse(w.steps);
    if (!parsed.success) continue;
    const def = parsed.data;
    const cands = (await c.query("SELECT * FROM rc_wf_candidates($1,$2,$3,$4::interval)", [def.trigger.event, def.trigger.months ?? 6, def.trigger.weeks ?? 4, LOOKBACK])).rows;
    for (const x of cands) {
      if (!matchesService(def, x.service)) continue;
      const anchor = new Date(x.anchor_at);
      const first = dueAt(def.steps[0], anchor);
      const r = await c.query(
        `INSERT INTO workflow_runs (clinic_id, workflow_id, workflow_version, subject_key, patient_id, appointment_id, call_id, anchor_at, next_step, next_due_at, is_simulated)
         VALUES (rc_clinic_id(), $1, $2, $3, $4, $5, $6, $7, 0, $8, $9) ON CONFLICT (workflow_id, subject_key) DO NOTHING`,
        [w.id, w.version, x.subject_key, x.patient_id, x.appointment_id, x.call_id, anchor, first, x.is_simulated]);
      created += r.rowCount ?? 0;
    }
  }
  return created;
}

async function conditionHolds(c: PoolClient, onlyIf: string, run: Record<string, any>): Promise<{ ok: boolean; stop?: string }> {
  if (onlyIf === "always") return { ok: true };
  if (onlyIf === "no_upcoming") {
    const up = (await c.query("SELECT rc_wf_patient_upcoming($1) AS u", [run.patient_id])).rows[0].u;
    return up ? { ok: false, stop: "Patient has booked." } : { ok: true };
  }
  const a = run.appointment_id ? (await c.query("SELECT * FROM rc_wf_appointment($1)", [run.appointment_id])).rows[0] : null;
  if (!a) return { ok: false, stop: "Appointment no longer exists." };
  if (onlyIf === "not_confirmed") {
    if (a.status === "cancelled") return { ok: false, stop: "Appointment cancelled." };
    if (a.status !== "scheduled") return { ok: false, stop: "Already confirmed." };
    if (new Date(a.starts_at).getTime() < Date.now() + 10 * 60_000) return { ok: false, stop: "Too close to the appointment time." };
    return { ok: true };
  }
  if (onlyIf === "not_rebooked") return a.rebooked || a.upcoming ? { ok: false, stop: "Patient rebooked." } : { ok: true };
  return { ok: true };
}

/** Processes due steps. Returns what was done, for logs and tests. */
async function processDue(clinicId: string) {
  const done: { runId: string; step: string; result: string }[] = [];
  const runs = await withContext(clinicCtx(clinicId), async (c) =>
    (await c.query(
      `SELECT r.*, w.steps AS def, w.enabled, w.id AS wf_id FROM workflow_runs r JOIN clinic_workflows w ON w.id = r.workflow_id
       WHERE r.status = 'active' AND r.next_due_at <= now() ORDER BY r.next_due_at LIMIT 100`)).rows);
  for (const run of runs) {
    const def = definitionSchema.safeParse(run.def);
    const log = (entry: object) => withContext(clinicCtx(clinicId), (c) => c.query("UPDATE workflow_runs SET log = log || $2::jsonb, updated_at = now() WHERE id = $1", [run.id, JSON.stringify([{ at: new Date().toISOString(), ...entry }])]));
    if (!def.success || !run.enabled) {
      await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE workflow_runs SET status='stopped', stop_reason=$2 WHERE id=$1", [run.id, !run.enabled ? "Workflow switched off." : "Workflow definition is not valid."]));
      continue;
    }
    const steps = def.data.steps;
    const step = steps[run.next_step];
    if (!step) { await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE workflow_runs SET status='done' WHERE id=$1", [run.id])); continue; }
    const cond = await withContext(clinicCtx(clinicId), (c) => conditionHolds(c, step.onlyIf, run));
    let result: string;
    if (!cond.ok) {
      result = `skipped: ${cond.stop}`;
      // a condition that fails ends the run (the reason it existed has gone)
      await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE workflow_runs SET status='done', stop_reason=$2 WHERE id=$1", [run.id, cond.stop]));
      await log({ step: step.key, result });
      done.push({ runId: run.id, step: step.key, result });
      continue;
    }
    try {
      if (step.action === "call") {
        const q = await queueOutbound(clinicId, {
          patientId: run.patient_id, purpose: step.purpose!, appointmentId: run.appointment_id, workflowId: run.wf_id,
          agentKind: AGENT_FOR[step.purpose!] ?? "lead_followup", simulated: run.is_simulated, summary: `${step.purpose!.replace(/_/g, " ")} call from workflow`,
        });
        result = q.mode === "prohibited" ? `not called: ${q.reason}` : q.mode === "suggest" ? "suggested to staff" : q.mode === "approval_required" ? "call waiting for approval" : "call queued";
      } else {
        await withContext(clinicCtx(clinicId), (c) => c.query(
          `INSERT INTO attention_items (clinic_id, kind, patient_id, appointment_id, reason, urgency, is_simulated)
           VALUES (rc_clinic_id(), 'failed_workflow', $1, $2, $3, 2, $4) ON CONFLICT DO NOTHING`,
          [run.patient_id, run.appointment_id, step.reason ?? "A workflow needs staff attention.", run.is_simulated]));
        result = "told staff";
      }
      const next = run.next_step + 1;
      await withContext(clinicCtx(clinicId), (c) => c.query(
        "UPDATE workflow_runs SET next_step = $2, next_due_at = $3, status = $4 WHERE id = $1",
        [run.id, next, steps[next] ? dueAt(steps[next], new Date(run.anchor_at)) : null, steps[next] ? "active" : "done"]));
    } catch (e) {
      result = `failed: ${(e as Error).message}`;
      await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE workflow_runs SET status='failed', stop_reason=$2 WHERE id=$1", [run.id, result]));
      await withContext(clinicCtx(clinicId), (c) => c.query(
        `INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency) VALUES (rc_clinic_id(), 'failed_workflow', $1, $2, 2) ON CONFLICT DO NOTHING`,
        [run.patient_id, `Workflow step failed: ${(e as Error).message.slice(0, 200)}`]));
    }
    await log({ step: step.key, result });
    done.push({ runId: run.id, step: step.key, result });
  }
  return done;
}

export async function workflowTick(clinicId: string) {
  const created = await withContext(clinicCtx(clinicId), discover);
  const processed = await processDue(clinicId);
  return { created, processed };
}
