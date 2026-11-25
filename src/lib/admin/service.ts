// RedClinic super admin: clinics, kill switch, feature switches, phone numbers, usage, audit log.
// The super admin may see all clinic data (spec 1); every look at a clinic is written to the audit log.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, UserError } from "../authz";
import { entitlements } from "../billing/service";
import { superAccessState } from "../privacy/service";

function requireSuper(actor: SignedInUser) {
  if (!actor.isSuperAdmin) throw new UserError("Only RedClinic can do this.");
}

export async function listClinics(actor: SignedInUser, days = 30) {
  return act(actor, async (c) => {
    requireSuper(actor);
    const r = await c.query("SELECT * FROM rc_admin_clinic_overview(now() - make_interval(days => $1))", [days]);
    return r.rows.map((x) => ({
      id: x.clinic_id as string, name: x.name as string, type: x.clinic_type as string, city: x.city as string | null, status: x.status as string,
      createdAt: x.created_at as Date, plan: x.plan as string | null, subStatus: x.sub_status as string | null, calls: Number(x.calls),
      appointments: Number(x.appointments), minutes: Number(x.minutes), staff: Number(x.staff), patients: Number(x.patients), lastCall: x.last_call as Date | null,
    }));
  });
}

async function inClinic<T>(c: PoolClient, actor: SignedInUser, clinicId: string, fn: () => Promise<T>) {
  // super admin context plus the clinic, so clinic-scoped functions (entitlements, ...) answer for that clinic
  await c.query("SELECT rc_set_context($1, $2, true)", [actor.userId, clinicId]);
  try { return await fn(); } finally { await c.query("SELECT rc_set_context($1, NULL, true)", [actor.userId]); }
}

export const FEATURE_SWITCHES: { key: string; label: string }[] = [
  { key: "nepa_inbound", label: "NEPA answers incoming calls" },
  { key: "nepa_outbound", label: "NEPA makes outgoing calls" },
  { key: "assistant", label: "In-app assistant" },
  { key: "whatsapp", label: "WhatsApp messages" },
  { key: "cap:export_data", label: "Staff may export data" },
  { key: "cap:import_patients", label: "Staff may import patients" },
  { key: "cap:merge_patients", label: "Staff may merge patients" },
];

export async function clinicDetail(actor: SignedInUser, clinicId: string) {
  return act(actor, async (c) => {
    requireSuper(actor);
    if (!z.string().uuid().safeParse(clinicId).success) throw new UserError("Clinic not found.");
    const cl = (await c.query("SELECT * FROM clinics WHERE id = $1", [clinicId])).rows[0];
    if (!cl) throw new UserError("Clinic not found.");
    const staff = (await c.query("SELECT id, display_name, email, role, status FROM users WHERE clinic_id = $1 ORDER BY role, display_name", [clinicId])).rows;
    const features = new Map((await c.query("SELECT feature, enabled FROM clinic_features WHERE clinic_id = $1", [clinicId])).rows.map((f) => [f.feature, f.enabled]));
    const phone = (await c.query("SELECT * FROM clinic_phone_numbers WHERE clinic_id = $1 AND status <> 'disabled' ORDER BY created_at DESC LIMIT 1", [clinicId])).rows[0] ?? null;
    // Patient data (calls) is read with the clinic in context: the clinic's data policy decides (migration 018).
    const { access, calls } = await inClinic(c, actor, clinicId, async () => {
      const access = await superAccessState(c, clinicId);
      const calls = access.open ? (await c.query(
        `SELECT x.id, x.started_at, x.direction, x.status, x.summary, x.is_simulated, x.duration_seconds FROM calls x WHERE x.clinic_id = $1 ORDER BY x.started_at DESC LIMIT 20`, [clinicId])).rows : [];
      return { access, calls };
    });
    const counts = (await c.query("SELECT * FROM rc_admin_clinic_counts($1)", [clinicId])).rows[0];
    const invoices = (await c.query("SELECT number, status, total_paise, issued_at, is_simulated FROM invoices WHERE clinic_id = $1 ORDER BY issued_at DESC LIMIT 20", [clinicId])).rows;
    const ent = await inClinic(c, actor, clinicId, () => entitlements(c));
    const terms = (await c.query("SELECT terms_version, accepted_at FROM terms_acceptances WHERE clinic_id = $1 ORDER BY accepted_at DESC LIMIT 1", [clinicId])).rows[0] ?? null;
    await audit(c, { ...actor, clinicId }, "super_admin_viewed_clinic", "clinic", clinicId);
    return {
      clinic: { id: cl.id, name: cl.name, type: cl.clinic_type, city: cl.city, phone: cl.phone, email: cl.email, status: cl.status, suspendedReason: cl.suspended_reason, suspendedAt: cl.suspended_at, createdAt: cl.created_at },
      staff: staff.map((s) => ({ id: s.id, name: s.display_name, email: s.email, role: s.role, status: s.status })),
      features: FEATURE_SWITCHES.map((f) => ({ ...f, enabled: features.get(f.key) ?? true })),
      phone: phone ? { clinicNumber: phone.clinic_number, receptionistNumber: phone.receptionist_number, fallback: phone.fallback_number, status: phone.status, mode: phone.forwarding_mode } : null,
      calls: calls.map((x) => ({ id: x.id, startedAt: x.started_at, direction: x.direction, status: x.status, summary: x.summary, simulated: x.is_simulated, seconds: x.duration_seconds })),
      counts, access, invoices: invoices.map((i) => ({ ...i, total_paise: Number(i.total_paise) })), entitlements: ent, terms,
    };
  });
}

/** Kill switch: pausing a clinic stops NEPA and hides clinic data from its staff until resumed. */
export async function setClinicStatus(actor: SignedInUser, clinicId: string, status: "active" | "suspended", reason: string) {
  return act(actor, async (c) => {
    requireSuper(actor);
    if (status === "suspended" && reason.trim().length < 5) throw new UserError("Say why the clinic is being paused.", "reason");
    const r = await c.query(
      `UPDATE clinics SET status=$2, suspended_reason=CASE WHEN $2='suspended' THEN $3 END, suspended_at=CASE WHEN $2='suspended' THEN now() END,
              suspended_by=CASE WHEN $2='suspended' THEN $4::uuid END WHERE id=$1`, [clinicId, status, reason.trim().slice(0, 300), actor.userId]);
    if (!r.rowCount) throw new UserError("Clinic not found.");
    await audit(c, { ...actor, clinicId }, status === "suspended" ? "clinic_suspended" : "clinic_resumed", "clinic", clinicId, { reason });
    return null;
  });
}

export async function setFeature(actor: SignedInUser, clinicId: string, feature: string, enabled: boolean) {
  return act(actor, async (c) => {
    requireSuper(actor);
    if (!FEATURE_SWITCHES.some((f) => f.key === feature)) throw new UserError("Unknown feature.");
    await c.query(`INSERT INTO clinic_features (clinic_id, feature, enabled) VALUES ($1,$2,$3)
                   ON CONFLICT (clinic_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`, [clinicId, feature, enabled]);
    // switching NEPA off is immediate: the agents stop
    if (feature === "nepa_inbound") await c.query("UPDATE nepa_agents SET enabled = $2 WHERE clinic_id = $1 AND kind = 'receptionist'", [clinicId, enabled]);
    if (feature === "nepa_outbound" && !enabled) await c.query("UPDATE nepa_agents SET enabled = false WHERE clinic_id = $1 AND kind <> 'receptionist'", [clinicId]);
    if (feature.startsWith("cap:") && !enabled) {
      // take the permission away from staff who had it
      await c.query("DELETE FROM staff_capabilities WHERE clinic_id = $1 AND capability = $2", [clinicId, feature.slice(4)]);
    }
    await audit(c, { ...actor, clinicId }, "feature_switched", "clinic", clinicId, { feature, enabled });
    return null;
  });
}

/** Gives the clinic its NEPA number (from the telephony provider) and marks forwarding as verified after a test call. */
export async function assignNumber(actor: SignedInUser, clinicId: string, input: { receptionistNumber: string; verified: boolean }) {
  return act(actor, async (c) => {
    requireSuper(actor);
    if (!/^[0-9+\-\s]{7,20}$/.test(input.receptionistNumber.trim())) throw new UserError("Enter a valid phone number.", "receptionistNumber");
    const taken = (await c.query("SELECT rc_clinic_for_number($1) AS id", [input.receptionistNumber])).rows[0].id;
    if (taken && taken !== clinicId) throw new UserError("That number already belongs to another clinic.", "receptionistNumber");
    const cur = (await c.query("SELECT id FROM clinic_phone_numbers WHERE clinic_id = $1 AND status <> 'disabled' ORDER BY created_at DESC LIMIT 1", [clinicId])).rows[0];
    if (cur) await c.query("UPDATE clinic_phone_numbers SET receptionist_number=$2, status=$3, verified_at=CASE WHEN $3='verified' THEN now() END WHERE id=$1",
      [cur.id, input.receptionistNumber.trim(), input.verified ? "verified" : "pending"]);
    else {
      const cl = (await c.query("SELECT phone FROM clinics WHERE id = $1", [clinicId])).rows[0];
      await c.query("INSERT INTO clinic_phone_numbers (clinic_id, clinic_number, receptionist_number, status, verified_at) VALUES ($1,$2,$3,$4,CASE WHEN $4='verified' THEN now() END)",
        [clinicId, cl?.phone ?? "", input.receptionistNumber.trim(), input.verified ? "verified" : "pending"]);
    }
    await audit(c, { ...actor, clinicId }, "number_assigned", "clinic", clinicId, { verified: input.verified });
    return null;
  });
}

export async function auditLog(actor: SignedInUser, f: { clinicId?: string; action?: string; superOnly?: boolean; limit?: number } = {}) {
  return act(actor, async (c) => {
    requireSuper(actor);
    const where = ["true"]; const args: unknown[] = [];
    if (f.clinicId) { args.push(f.clinicId); where.push(`a.clinic_id = $${args.length}`); }
    if (f.action) { args.push(`%${f.action}%`); where.push(`a.action ILIKE $${args.length}`); }
    if (f.superOnly) where.push("a.actor_is_super");
    args.push(Math.min(f.limit ?? 200, 500));
    const r = await c.query(
      `SELECT a.*, u.display_name AS actor, cl.name AS clinic FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN clinics cl ON cl.id = a.clinic_id
       WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT $${args.length}`, args);
    return r.rows.map((x) => ({ id: Number(x.id), at: x.created_at as Date, actor: (x.actor ?? (x.actor_user_id ? "Unknown" : "NEPA / system")) as string, isSuper: x.actor_is_super as boolean,
      clinic: x.clinic as string | null, action: x.action as string, entity: x.entity as string, entityId: x.entity_id as string, detail: x.detail }));
  });
}
