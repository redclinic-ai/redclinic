// Clinic workflows: list, edit (each save is a new version), switch on/off and automatic, add new ones,
// and accept or keep master updates from RedClinic. Clinic edits never change the master templates.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, requireCap, UserError } from "../authz";
import { definitionSchema, describeStep, type Definition } from "./definition";

export interface WorkflowItem {
  id: string; name: string; description: string | null; enabled: boolean; automatic: boolean; packKey: string | null;
  templateKey: string | null; format: number; version: number; editedByClinic: boolean; definition: Definition | null;
  summary: string[]; activeRuns: number; updateAvailable: { packVersion: number; name: string; definition: unknown; description: string | null } | null;
}

export async function listWorkflows(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT w.*, (SELECT count(*) FROM workflow_runs r WHERE r.workflow_id = w.id AND r.status = 'active')::int AS active_runs
       FROM clinic_workflows w ORDER BY w.step_format DESC, w.pack_key NULLS LAST, w.name`);
    const out: WorkflowItem[] = [];
    for (const x of r.rows) {
      const def = x.step_format === 2 ? definitionSchema.safeParse(x.steps) : null;
      const upd = (await c.query("SELECT * FROM rc_workflow_master_update($1)", [x.id])).rows[0];
      out.push({
        id: x.id, name: x.name, description: x.description, enabled: x.enabled, automatic: x.automatic_enabled, packKey: x.pack_key,
        templateKey: x.template_key, format: x.step_format, version: x.version, editedByClinic: x.edited_by_clinic,
        definition: def?.success ? def.data : null, summary: def?.success ? def.data.steps.map(describeStep) : ["Older format. Use the RedClinic update to keep using it."],
        activeRuns: x.active_runs,
        updateAvailable: upd ? { packVersion: upd.pack_version, name: upd.name, definition: upd.steps, description: upd.description } : null,
      });
    }
    return out;
  });
}

export async function workflowHistory(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT v.version, v.name, v.change_note, v.created_at, v.enabled, v.automatic_enabled, u.display_name AS by
       FROM clinic_workflow_versions v LEFT JOIN users u ON u.id = v.edited_by WHERE v.workflow_id = $1 ORDER BY v.version DESC`, [id]);
    return r.rows.map((x) => ({ version: x.version, name: x.name, note: x.change_note, at: x.created_at, by: x.by, enabled: x.enabled, automatic: x.automatic_enabled }));
  });
}

async function snapshot(c: import("pg").PoolClient, actor: SignedInUser, id: string, note: string) {
  await c.query(
    `INSERT INTO clinic_workflow_versions (clinic_id, workflow_id, version, name, steps, enabled, automatic_enabled, change_note, edited_by)
     SELECT clinic_id, id, version, name, steps, enabled, automatic_enabled, $2, $3 FROM clinic_workflows WHERE id = $1
     ON CONFLICT (workflow_id, version) DO NOTHING`, [id, note, actor.userId]);
}

/** Saves an edited definition as a new version. The previous version is kept for restore. */
export async function saveWorkflow(actor: SignedInUser, id: string, input: { name: string; definition: unknown; note?: string }) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow", "You don't have permission to change workflows.");
    const name = z.string().trim().min(3, "Give the workflow a name.").max(80).safeParse(input.name);
    if (!name.success) throw new UserError(name.error.issues[0].message, "name");
    const def = definitionSchema.safeParse(input.definition);
    if (!def.success) throw new UserError(def.error.issues[0].message);
    const cur = (await c.query("SELECT version FROM clinic_workflows WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!cur) throw new UserError("Workflow not found.");
    await snapshot(c, actor, id, "Before edit");
    await c.query(
      `UPDATE clinic_workflows SET name=$2, steps=$3, step_format=2, edited_by_clinic=true, version=version+1, updated_by=$4, updated_at=now() WHERE id=$1`,
      [id, name.data, def.data, actor.userId]);
    await snapshot(c, actor, id, input.note?.trim() || "Edited");
    await audit(c, actor, "workflow_edited", "clinic_workflow", id, { version: cur.version + 1 });
    return cur.version + 1;
  });
}

export async function setWorkflowSwitches(actor: SignedInUser, id: string, s: { enabled?: boolean; automatic?: boolean }) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow", "You don't have permission to change workflows.");
    if (s.automatic && actor.role !== "clinic_admin") throw new UserError("Only the clinic admin can let a workflow run automatically.");
    const w = (await c.query("SELECT step_format FROM clinic_workflows WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!w) throw new UserError("Workflow not found.");
    if (w.step_format !== 2 && (s.enabled || s.automatic)) throw new UserError("Apply the RedClinic update before switching this workflow on.");
    await c.query(
      `UPDATE clinic_workflows SET enabled = coalesce($2, enabled), automatic_enabled = CASE WHEN coalesce($2, enabled) = false THEN false ELSE coalesce($3, automatic_enabled) END,
              version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1`, [id, s.enabled ?? null, s.automatic ?? null, actor.userId]);
    const note = s.enabled === false ? "Switched off" : s.enabled ? "Switched on" : s.automatic ? "Set to automatic" : "Set to ask for approval";
    await snapshot(c, actor, id, note);
    await audit(c, actor, "workflow_switches_changed", "clinic_workflow", id, s);
    return null;
  });
}

export async function restoreWorkflowVersion(actor: SignedInUser, id: string, version: number) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    const v = (await c.query("SELECT * FROM clinic_workflow_versions WHERE workflow_id = $1 AND version = $2", [id, version])).rows[0];
    if (!v) throw new UserError("Version not found.");
    await c.query(
      `UPDATE clinic_workflows SET name=$2, steps=$3, enabled=$4, automatic_enabled=$5 AND $6, version=version+1, edited_by_clinic=true, updated_by=$7, updated_at=now() WHERE id=$1`,
      [id, v.name, v.steps, v.enabled, v.automatic_enabled, actor.role === "clinic_admin", actor.userId]);
    await snapshot(c, actor, id, `Restored version ${version}`);
    await audit(c, actor, "workflow_restored", "clinic_workflow", id, { version });
    return null;
  });
}

/** A new workflow made by the clinic (starts switched off). */
export async function createWorkflow(actor: SignedInUser, input: { name: string; definition: unknown }) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    const def = definitionSchema.safeParse(input.definition);
    if (!def.success) throw new UserError(def.error.issues[0].message);
    if (input.name.trim().length < 3) throw new UserError("Give the workflow a name.", "name");
    const r = await c.query(
      `INSERT INTO clinic_workflows (clinic_id, name, steps, step_format, enabled, automatic_enabled, edited_by_clinic, updated_by, template_key)
       VALUES ($1,$2,$3,2,false,false,true,$4,NULL) RETURNING id`, [actor.clinicId, input.name.trim().slice(0, 80), def.data, actor.userId]);
    await snapshot(c, actor, r.rows[0].id, "Created");
    await audit(c, actor, "workflow_created", "clinic_workflow", r.rows[0].id);
    return r.rows[0].id as string;
  });
}

/** Take RedClinic's newer template. The clinic's current version is kept in the history. */
export async function applyMasterUpdate(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    const u = (await c.query("SELECT * FROM rc_workflow_master_update($1)", [id])).rows[0];
    if (!u) throw new UserError("There is no update for this workflow.");
    await snapshot(c, actor, id, "Before RedClinic update");
    await c.query(
      `UPDATE clinic_workflows SET name=$2, steps=$3, description=$4, source_template_id=$5, source_pack_version=$6, step_format=2,
              edited_by_clinic=false, version=version+1, updated_by=$7, updated_at=now(), dismissed_pack_version=NULL WHERE id=$1`,
      [id, u.name, u.steps, u.description, u.template_id, u.pack_version, actor.userId]);
    await snapshot(c, actor, id, `RedClinic update (pack version ${u.pack_version})`);
    await audit(c, actor, "workflow_master_update_applied", "clinic_workflow", id, { pack_version: u.pack_version });
    return null;
  });
}

export async function keepMyVersion(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    const u = (await c.query("SELECT pack_version FROM rc_workflow_master_update($1)", [id])).rows[0];
    if (!u) throw new UserError("There is no update for this workflow.");
    await c.query("UPDATE clinic_workflows SET dismissed_pack_version = $2 WHERE id = $1", [id, u.pack_version]);
    await audit(c, actor, "workflow_master_update_dismissed", "clinic_workflow", id, { pack_version: u.pack_version });
    return null;
  });
}

export async function workflowRuns(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT r.id, r.status, r.next_step, r.next_due_at, r.stop_reason, r.log, r.created_at, p.name AS patient FROM workflow_runs r
       LEFT JOIN patients p ON p.id = r.patient_id WHERE r.workflow_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [id]);
    return r.rows.map((x) => ({ id: x.id, status: x.status, nextStep: x.next_step, nextDueAt: x.next_due_at, stopReason: x.stop_reason, log: x.log as { at: string; step: string; result: string }[], createdAt: x.created_at, patient: x.patient }));
  });
}
