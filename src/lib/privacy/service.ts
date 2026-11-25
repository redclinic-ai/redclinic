// V2 data policy: who at RedClinic may open a clinic's patient data, and how long call data is kept.
// The rules themselves live in the database (migration 018); this file is the readable front door to them.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";
import { withoutUser } from "../db";
import { getEmailAdapter } from "../email";
import { getStorage } from "../storage";
import { reportError } from "../monitoring";

export type SuperAccess = "full" | "request";
export const RETENTION_CHOICES = [null, 30, 90, 180, 365, 730] as const; // null = keep
export interface DataPolicy {
  superAccess: SuperAccess;
  recordingDays: number | null;
  transcriptDays: number | null;
  assistantLogDays: number | null;
  telephonyEventDays: number | null;
  lastPurgeAt: Date | null;
}
const DEFAULT_POLICY: DataPolicy = { superAccess: "full", recordingDays: null, transcriptDays: null, assistantLogDays: null, telephonyEventDays: null, lastPurgeAt: null };

export async function getDataPolicy(actor: SignedInUser) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = (await c.query("SELECT * FROM clinic_data_policy WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    const policy: DataPolicy = p ? {
      superAccess: p.super_access, recordingDays: p.recording_days, transcriptDays: p.transcript_days,
      assistantLogDays: p.assistant_log_days, telephonyEventDays: p.telephony_event_days, lastPurgeAt: p.last_purge_at,
    } : DEFAULT_POLICY;
    const grants = (await c.query(
      `SELECT g.*, u.display_name AS requester FROM super_access_grants g LEFT JOIN users u ON u.id = g.requested_by
        WHERE g.clinic_id = $1 ORDER BY g.created_at DESC LIMIT 20`, [actor.clinicId])).rows.map(grantRow);
    return { policy, grants };
  });
}

const grantRow = (g: Record<string, unknown>) => ({
  id: g.id as string, reason: g.reason as string, hours: g.hours as number, status: g.status as string,
  requester: (g.requester as string) ?? "RedClinic", createdAt: g.created_at as Date, decidedAt: g.decided_at as Date | null,
  expiresAt: g.expires_at as Date | null,
  active: g.status === "approved" && !!g.expires_at && (g.expires_at as Date) > new Date(),
});

const days = z.union([z.literal(""), z.coerce.number().int().refine((n) => (RETENTION_CHOICES as readonly (number | null)[]).includes(n), "Choose one of the listed periods.")])
  .transform((v) => (v === "" ? null : v));
const PolicyInput = z.object({
  superAccess: z.enum(["full", "request"], { message: "Choose how RedClinic may open patient data." }),
  recordingDays: days, transcriptDays: days, assistantLogDays: days, telephonyEventDays: days,
});

export async function saveDataPolicy(actor: SignedInUser, input: Record<string, string>) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    if (actor.isSuperAdmin) throw new UserError("Only the clinic can change its data policy.");
    const p = PolicyInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const v = p.data;
    if (v.transcriptDays !== null && v.recordingDays !== null && v.transcriptDays < v.recordingDays) {
      throw new UserError("Keep transcripts at least as long as recordings, so a call can still be read after its audio is gone.", "transcriptDays");
    }
    await c.query(
      `INSERT INTO clinic_data_policy (clinic_id, super_access, recording_days, transcript_days, assistant_log_days, telephony_event_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (clinic_id) DO UPDATE SET super_access = $2, recording_days = $3, transcript_days = $4, assistant_log_days = $5,
         telephony_event_days = $6, updated_by = $7, updated_at = now()`,
      [actor.clinicId, v.superAccess, v.recordingDays, v.transcriptDays, v.assistantLogDays, v.telephonyEventDays, actor.userId]);
    await audit(c, actor, "data_policy_saved", "clinic", actor.clinicId!, v);
    return v;
  });
}

/** Clinic admin approves (for the hours asked) or denies a pending request, or revokes an active grant. */
export async function decideGrant(actor: SignedInUser, grantId: string, decision: "approve" | "deny" | "revoke") {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    if (!z.string().uuid().safeParse(grantId).success) throw new UserError("Request not found.");
    const g = (await c.query("SELECT * FROM super_access_grants WHERE id = $1 AND clinic_id = $2", [grantId, actor.clinicId])).rows[0];
    if (!g) throw new UserError("Request not found.");
    if (decision === "revoke") {
      if (g.status !== "approved") throw new UserError("Only an approved access can be revoked.");
      await c.query("UPDATE super_access_grants SET status = 'revoked', decided_by = $2, decided_at = now(), expires_at = now() WHERE id = $1", [grantId, actor.userId]);
    } else {
      if (g.status !== "requested") throw new UserError("This request has already been answered.");
      await c.query(
        `UPDATE super_access_grants SET status = $2, decided_by = $3, decided_at = now(),
           expires_at = CASE WHEN $2 = 'approved' THEN now() + make_interval(hours => hours) END WHERE id = $1`,
        [grantId, decision === "approve" ? "approved" : "denied", actor.userId]);
    }
    await audit(c, actor, `super_access_${decision === "approve" ? "approved" : decision === "deny" ? "denied" : "revoked"}`, "super_access_grant", grantId);
    return true;
  });
}

// ---------- RedClinic (super admin) side ----------

const RequestInput = z.object({
  reason: z.string().trim().min(10, "Say why you need access (at least 10 characters).").max(500),
  hours: z.coerce.number().int().refine((h) => [4, 24, 72].includes(h), "Choose 4, 24 or 72 hours."),
});

export async function requestAccess(actor: SignedInUser, clinicId: string, input: { reason: string; hours: string | number }) {
  return act(actor, async (c) => {
    if (!actor.isSuperAdmin) throw new UserError("Only RedClinic can do this.");
    if (!z.string().uuid().safeParse(clinicId).success) throw new UserError("Clinic not found.");
    const p = RequestInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const open = (await c.query("SELECT 1 FROM super_access_grants WHERE clinic_id = $1 AND status = 'requested'", [clinicId])).rowCount;
    if (open) throw new UserError("There is already a request waiting for the clinic's answer.");
    const id = (await c.query(
      "INSERT INTO super_access_grants (clinic_id, requested_by, reason, hours) VALUES ($1,$2,$3,$4) RETURNING id",
      [clinicId, actor.userId, p.data.reason, p.data.hours])).rows[0].id as string;
    await audit(c, { ...actor, clinicId }, "super_access_requested", "super_access_grant", id, { hours: p.data.hours });
    const admins = (await c.query("SELECT email FROM users WHERE clinic_id = $1 AND role = 'clinic_admin' AND status = 'active'", [clinicId])).rows;
    for (const a of admins) {
      await getEmailAdapter().send({
        to: a.email,
        subject: "RedClinic asks to open your clinic's patient data",
        text: `RedClinic support has asked for ${p.data.hours} hours of access to your clinic's patient data.\n\nReason: ${p.data.reason}\n\nApprove or deny it in RedClinic → Settings → Privacy & data. Nothing is opened until you approve.`,
      }).catch((e) => reportError(e, { where: "super access email" }));
    }
    return id;
  });
}

/** What the super admin may see for one clinic right now. Runs with that clinic in the request context. */
export async function superAccessState(c: import("pg").PoolClient, clinicId: string) {
  const mode = ((await c.query("SELECT super_access FROM clinic_data_policy WHERE clinic_id = $1", [clinicId])).rows[0]?.super_access ?? "full") as SuperAccess;
  const open = (await c.query("SELECT rc_super_patient_access() AS ok")).rows[0].ok as boolean;
  const grants = (await c.query(
    "SELECT g.*, u.display_name AS requester FROM super_access_grants g LEFT JOIN users u ON u.id = g.requested_by WHERE g.clinic_id = $1 ORDER BY g.created_at DESC LIMIT 5",
    [clinicId])).rows.map(grantRow);
  return { mode, open, grants };
}

// ---------- retention job (run by the scheduler) ----------

export async function runRetention(): Promise<{ clinic: string; result: Record<string, number> }[]> {
  const due: string[] = await withoutUser(async (c) => (await c.query("SELECT rc_retention_due() AS id")).rows.map((r) => r.id));
  const out = [];
  for (const clinic of due) {
    try {
      const recordings = await withoutUser(async (c) => (await c.query("SELECT * FROM rc_expired_recordings($1)", [clinic])).rows);
      let deleted = 0;
      for (const r of recordings) {
        await getStorage().remove(r.recording_ref);       // file first: a failure leaves the reference for the next run
        await withoutUser((c) => c.query("SELECT rc_mark_recording_deleted($1)", [r.call_id]));
        deleted++;
      }
      const result = await withoutUser(async (c) => (await c.query("SELECT rc_apply_retention($1, $2) AS r", [clinic, deleted])).rows[0].r);
      out.push({ clinic, result: { recordings: deleted, ...result } });
    } catch (e) { reportError(e, { where: "retention", clinic }); }
  }
  return out;
}
