// Staff list and permissions (the clinic admin decides what each person can do).
import type { SignedInUser } from "../auth/service";
import { act, audit, requireCap, UserError } from "../authz";

export interface StaffMember {
  id: string; displayName: string; email: string; role: string; status: string;
  hasPassword: boolean; capabilities: string[]; createdAt: Date;
}

export interface Capability { code: string; description: string; allowed: boolean }

/** Capabilities a clinic admin can hand out, in a fixed order, grouped for the screen. */
export const CAPABILITY_GROUPS: { title: string; codes: string[] }[] = [
  { title: "Patients", codes: ["view_patients", "edit_patient", "view_patient_history", "record_consent", "merge_patients", "import_patients", "export_data"] },
  { title: "Documents", codes: ["upload_document", "view_documents"] },
  { title: "Appointments and calls", codes: ["manage_appointments", "view_calls", "view_call_transcripts"] },
  { title: "Needs attention and approvals", codes: ["manage_attention", "view_approvals", "approve_actions"] },
  { title: "Clinic", codes: ["view_results", "edit_workflow", "manage_settings", "manage_staff", "view_audit_log", "manage_billing"] },
];

export async function listStaff(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT u.id, u.display_name, u.email, u.role, u.status, u.created_at,
              coalesce(array_agg(sc.capability ORDER BY sc.capability) FILTER (WHERE sc.capability IS NOT NULL), '{}') AS caps,
              EXISTS (SELECT 1 FROM rc_staff_has_password(u.id) h WHERE h) AS has_password
       FROM users u LEFT JOIN staff_capabilities sc ON sc.user_id = u.id
       WHERE u.role <> 'super_admin'
       GROUP BY u.id ORDER BY u.status, u.role = 'clinic_admin' DESC, u.display_name`,
    );
    return r.rows.map((x) => ({
      id: x.id, displayName: x.display_name, email: x.email, role: x.role, status: x.status,
      hasPassword: x.has_password, capabilities: x.caps, createdAt: x.created_at,
    })) as StaffMember[];
  });
}

export async function listCapabilities(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query("SELECT code, description, rc_capability_allowed($1, code) AS allowed FROM capabilities", [actor.clinicId]);
    return r.rows as Capability[];
  });
}

/** Replaces a staff member's capabilities. Only capabilities the super admin allows for the clinic can be granted. */
export async function setStaffCapabilities(actor: SignedInUser, userId: string, capabilities: string[]) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_staff");
    const u = (await c.query("SELECT id, role, status FROM users WHERE id = $1", [userId])).rows[0];
    if (!u) throw new UserError("Staff member not found.");
    if (u.role === "clinic_admin") throw new UserError("The clinic admin always has every permission.");
    const wanted = [...new Set(capabilities)];
    const before: string[] = (await c.query("SELECT capability FROM staff_capabilities WHERE user_id = $1", [userId])).rows.map((x) => x.capability);
    const add = wanted.filter((x) => !before.includes(x));
    const remove = before.filter((x) => !wanted.includes(x));
    if (remove.length) await c.query("DELETE FROM staff_capabilities WHERE user_id = $1 AND capability = ANY($2)", [userId, remove]);
    for (const cap of add) {
      try {
        await c.query("SAVEPOINT g");
        await c.query("INSERT INTO staff_capabilities (user_id, clinic_id, capability, granted_by) VALUES ($1,$2,$3,$4)", [userId, actor.clinicId, cap, actor.userId]);
        await c.query("RELEASE SAVEPOINT g");
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT g");
        if ((e as { code?: string }).code === "42501") throw new UserError(`"${cap}" is not available on your RedClinic plan.`);
        if ((e as { code?: string }).code === "23503") throw new UserError(`Unknown permission "${cap}".`);
        throw e;
      }
    }
    await audit(c, actor, "staff_permissions_changed", "user", userId, { added: add, removed: remove });
    return { added: add, removed: remove };
  });
}
