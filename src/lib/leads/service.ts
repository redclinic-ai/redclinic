// Leads (V2): enquiries from Meta lead ads (Facebook/Instagram forms) or typed in by staff.
// A lead always becomes, or matches, a patient record with a permanent ID, so NEPA's follow-up and everything
// after it hangs off the patient. The "lead received" workflow event starts the follow-up.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";
import { withContext, withoutUser, type DbContext } from "../db";
import { reportError } from "../monitoring";
import { getLeadAds, readFields, type LeadNotice } from "./provider";

const clinicCtx = (clinicId: string): DbContext => ({ userId: null, clinicId, isSuperAdmin: false });

// ---------- lead forms (Settings → Lead ads) ----------

const FormInput = z.object({
  label: z.string().trim().min(2, "Give the form a name you'll recognise, e.g. “Braces offer – Instagram”.").max(80),
  pageId: z.string().trim().regex(/^\d{3,30}$/, "The page id is the number in your Facebook page's About → Page transparency (digits only)."),
  formId: z.string().trim().regex(/^\d{3,30}$/, "The form id is the number shown for the form in Meta Ads Manager → Instant forms (digits only)."),
});

export async function listLeadForms(actor: SignedInUser) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const r = await c.query(
      `SELECT f.*, (SELECT count(*) FROM leads l WHERE l.form_id = f.id)::int AS leads FROM lead_forms f ORDER BY f.created_at DESC`);
    return { forms: r.rows.map((f) => ({ id: f.id as string, label: f.label as string, pageId: f.page_id as string, formId: f.form_id as string, enabled: f.enabled as boolean, leads: f.leads as number })),
      provider: getLeadAds().info };
  });
}

export async function addLeadForm(actor: SignedInUser, input: { label: string; pageId: string; formId: string }) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = FormInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const taken = (await c.query("SELECT * FROM rc_lead_form_clinic('meta', $1)", [p.data.formId])).rows[0];
    if (taken) throw new UserError(taken.clinic_id === actor.clinicId ? "This form is already linked." : "This form is linked to another clinic.", "formId");
    const id = (await c.query(
      "INSERT INTO lead_forms (clinic_id, page_id, form_id, label, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [actor.clinicId, p.data.pageId, p.data.formId, p.data.label, actor.userId])).rows[0].id as string;
    await audit(c, actor, "lead_form_linked", "lead_form", id, { formId: p.data.formId });
    return id;
  });
}

export async function setLeadFormEnabled(actor: SignedInUser, id: string, enabled: boolean) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const r = await c.query("UPDATE lead_forms SET enabled = $2 WHERE id = $1 RETURNING id", [id, enabled]);
    if (!r.rowCount) throw new UserError("Form not found.");
    await audit(c, actor, enabled ? "lead_form_enabled" : "lead_form_disabled", "lead_form", id);
    return enabled;
  });
}

// ---------- receiving ----------

/** Handles verified webhook notices. Returns one result per notice. */
export async function receiveLeads(notices: LeadNotice[], opts: { simulated: boolean }) {
  const out: { leadId: string; result: string }[] = [];
  for (const n of notices) {
    try {
      const where = await withoutUser(async (c) => (await c.query("SELECT * FROM rc_lead_form_clinic('meta', $1)", [n.formId])).rows[0]);
      if (!where) { out.push({ leadId: n.leadId, result: "form not linked to a clinic" }); continue; }
      const details = await getLeadAds().fetchLead(n);
      const f = readFields(details.fieldData);
      if (!f.name && !f.phone) { out.push({ leadId: n.leadId, result: "no name or phone in the lead" }); continue; }
      const r = await withContext(clinicCtx(where.clinic_id), async (c) => (await c.query(
        "SELECT * FROM rc_lead_ingest('meta_lead_ad', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [n.leadId, where.form, f.name || "Lead without a name", f.phone, f.email, f.problem, f.answers, details.campaign, f.optIn, opts.simulated])).rows[0]);
      out.push({ leadId: n.leadId, result: r.duplicate ? "duplicate" : r.new_patient ? "new patient" : "matched existing patient" });
    } catch (e) {
      reportError(e, { where: "lead ingest" });
      out.push({ leadId: n.leadId, result: `failed: ${(e as Error).message.slice(0, 120)}` });
    }
  }
  return out;
}

const ManualInput = z.object({
  name: z.string().trim().min(2, "Enter the person's name.").max(120),
  phone: z.string().trim().refine((p) => p.replace(/\D/g, "").length >= 10, "Enter a 10-digit mobile number."),
  problem: z.string().trim().max(300).optional().default(""),
  whatsappOptIn: z.boolean().default(false),
});

/** Staff note an enquiry by hand (walk-in, a call to a staff mobile, a referral). Same follow-up as a lead ad. */
export async function addManualLead(actor: SignedInUser, input: { name: string; phone: string; problem?: string; whatsappOptIn?: boolean }) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_patient");
    const p = ManualInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const r = (await c.query(
      "SELECT * FROM rc_lead_ingest('manual', $1, NULL, $2, $3, NULL, $4, '{}'::jsonb, '{}'::jsonb, $5, false)",
      [`manual-${crypto.randomUUID()}`, p.data.name, p.data.phone, p.data.problem, p.data.whatsappOptIn])).rows[0];
    await audit(c, actor, "lead_added", "lead", r.lead_id);
    return { leadId: r.lead_id as string, patientId: r.patient_id as string, newPatient: r.new_patient as boolean };
  });
}

// ---------- list and status ----------

export type LeadStage = "new" | "contacted" | "booked" | "not_interested" | "duplicate";
export async function listLeads(actor: SignedInUser, f: { stage?: string; days?: number } = {}) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patients");
    const days = Math.min(Math.max(Number(f.days) || 30, 1), 365);
    const r = await c.query(
      `SELECT l.*, p.patient_code, fm.label AS form_label,
              EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = l.patient_id AND a.created_at >= l.created_at AND a.status <> 'cancelled') AS booked,
              (SELECT max(x.started_at) FROM calls x WHERE x.patient_id = l.patient_id AND x.started_at >= l.created_at) AS last_call
         FROM leads l LEFT JOIN patients p ON p.id = l.patient_id LEFT JOIN lead_forms fm ON fm.id = l.form_id
        WHERE l.created_at > now() - make_interval(days => $1) ORDER BY l.created_at DESC LIMIT 500`, [days]);
    const rows = r.rows.map((l) => {
      const stage: LeadStage = l.booked ? "booked" : l.status === "new" && l.last_call ? "contacted" : l.status;
      return { id: l.id as string, name: l.name as string, phone: l.phone as string | null, source: l.source as string, formLabel: l.form_label as string | null,
        patientId: l.patient_id as string | null, patientCode: l.patient_code as string | null, answers: l.answers as Record<string, string>,
        campaign: l.campaign as Record<string, string>, stage, createdAt: l.created_at as Date, lastCall: l.last_call as Date | null, simulated: l.is_simulated as boolean };
    });
    const counts = { all: rows.length, new: 0, contacted: 0, booked: 0, not_interested: 0, duplicate: 0 } as Record<string, number>;
    for (const x of rows) counts[x.stage]++;
    return { leads: f.stage && f.stage !== "all" ? rows.filter((x) => x.stage === f.stage) : rows, counts, days };
  });
}

export async function setLeadStatus(actor: SignedInUser, id: string, status: "contacted" | "not_interested" | "new") {
  return act(actor, async (c) => {
    await requireCap(c, "manage_attention");
    if (!["contacted", "not_interested", "new"].includes(status)) throw new UserError("Unknown status.");
    const r = await c.query("UPDATE leads SET status = $2, status_by = $3, status_at = now() WHERE id = $1 RETURNING id", [id, status, actor.userId]);
    if (!r.rowCount) throw new UserError("Lead not found.");
    if (status === "not_interested") {
      // stop the follow-up for this lead
      await c.query(`UPDATE workflow_runs SET status = 'stopped', stop_reason = 'Lead marked not interested.' WHERE subject_key = $1 AND status = 'active'`, [`lead:${id}`]);
    }
    await audit(c, actor, `lead_${status}`, "lead", id);
    return status;
  });
}
