// Patient records: register (with duplicate check), edit, search, clinical notes, consent, merge, CSV import/export.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, firstIssue, requireCap, UserError } from "../authz";
import { currentConsentWordings } from "../clinic/service";
import { parseCsv, toCsv } from "./csv";

export interface PatientSummary {
  id: string; code: string; name: string; phone: string | null; ageYears: number | null; gender: string | null;
  consentStatus: string; assignedDoctor: string | null; registeredAt: Date; lastVisit: Date | null; nextVisit: Date | null;
}

export interface Patient extends PatientSummary {
  email: string | null; dateOfBirth: string | null; address: string | null; assignedDoctorId: string | null;
  firstProblem: string | null; mergedInto: string | null;
  clinical: { medicalHistory: string; allergies: string; notes: string } | null; // null = no permission to see
}

export interface Duplicate { patientId: string; code: string; name: string; phone: string | null; reason: string }

const optText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);

export const patientSchema = z.object({
  name: z.string().trim().min(2, "Enter the patient's name.").max(120),
  phone: z.string().trim().optional().transform((v) => v || null)
    .refine((v) => v === null || /^[0-9+\-\s]{7,20}$/.test(v), "Enter a valid phone number."),
  email: z.string().trim().optional().transform((v) => v || null)
    .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email."),
  dateOfBirth: z.string().optional().transform((v) => v || null)
    .refine((v) => v === null || (/^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v) <= new Date()), "Enter a valid date of birth."),
  ageYears: z.union([z.literal(""), z.coerce.number().int().min(0, "Age must be 0 to 130.").max(130, "Age must be 0 to 130.")]).optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  gender: optText(30),
  address: optText(300),
  assignedDoctorId: z.string().optional().transform((v) => v || null),
  firstProblem: optText(500),
});
export type PatientInput = z.input<typeof patientSchema>;

const SUMMARY_SQL = `
  SELECT p.id, p.patient_code, p.name, p.phone, p.age_years, p.gender, p.consent_status, p.registered_at,
         d.display_name AS doctor,
         (SELECT max(starts_at) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'completed') AS last_visit,
         (SELECT min(starts_at) FROM appointments a WHERE a.patient_id = p.id AND a.status IN ('scheduled','confirmed') AND a.starts_at > now()) AS next_visit
  FROM patients p LEFT JOIN users d ON d.id = p.assigned_doctor_id`;

function toSummary(x: Record<string, any>): PatientSummary {
  return {
    id: x.id, code: x.patient_code, name: x.name, phone: x.phone, ageYears: x.age_years, gender: x.gender,
    consentStatus: x.consent_status, assignedDoctor: x.doctor, registeredAt: x.registered_at,
    lastVisit: x.last_visit, nextVisit: x.next_visit,
  };
}

async function findDuplicates(c: PoolClient, d: { name: string; phone: string | null; dateOfBirth: string | null; ageYears: number | null }, exclude?: string) {
  const r = await c.query("SELECT * FROM rc_find_duplicates($1,$2,$3,$4,$5)", [d.name, d.phone, d.dateOfBirth, d.ageYears, exclude ?? null]);
  return r.rows.map((x) => ({ patientId: x.patient_id, code: x.patient_code, name: x.name, phone: x.phone, reason: x.reason })) as Duplicate[];
}

async function checkDoctor(c: PoolClient, doctorId: string | null) {
  if (!doctorId) return;
  const r = await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'doctor' AND status = 'active'", [doctorId]);
  if (!r.rowCount) throw new UserError("Choose a doctor from the list.", "assignedDoctorId");
}

/**
 * Registers a patient. If possible duplicates exist and `confirmNew` is not set, nothing is saved and the
 * duplicates are returned so staff can pick the existing patient instead.
 */
export async function registerPatient(actor: SignedInUser, input: PatientInput, opts: { confirmNew?: boolean } = {}) {
  return act(actor, async (c): Promise<{ patientId: string; code: string } | { duplicates: Duplicate[] }> => {
    await requireCap(c, "edit_patient", "You don't have permission to add patients.");
    const p = patientSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    await checkDoctor(c, d.assignedDoctorId);
    if (!opts.confirmNew) {
      const dups = await findDuplicates(c, d);
      if (dups.length) return { duplicates: dups };
    }
    const r = await c.query(
      `INSERT INTO patients (clinic_id, name, phone, email, date_of_birth, age_years, gender, address, assigned_doctor_id, first_problem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, patient_code`,
      [actor.clinicId, d.name, d.phone, d.email, d.dateOfBirth, d.ageYears, d.gender, d.address, d.assignedDoctorId, d.firstProblem],
    );
    await audit(c, actor, "patient_registered", "patient", r.rows[0].id, { duplicates_overridden: !!opts.confirmNew });
    return { patientId: r.rows[0].id, code: r.rows[0].patient_code };
  });
}

export async function updatePatient(actor: SignedInUser, patientId: string, input: PatientInput) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_patient");
    const p = patientSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    await checkDoctor(c, d.assignedDoctorId);
    const before = (await c.query("SELECT phone FROM patients WHERE id = $1 AND merged_into IS NULL", [patientId])).rows[0];
    if (!before) throw new UserError("Patient not found.");
    await c.query(
      `UPDATE patients SET name=$2, phone=$3, email=$4, date_of_birth=$5, age_years=$6, gender=$7, address=$8,
              assigned_doctor_id=$9, first_problem=$10 WHERE id=$1`,
      [patientId, d.name, d.phone, d.email, d.dateOfBirth, d.ageYears, d.gender, d.address, d.assignedDoctorId, d.firstProblem],
    );
    await audit(c, actor, "patient_updated", "patient", patientId, before.phone !== d.phone ? { phone_changed: true } : {});
    return null;
  });
}

export interface PatientFilter { q?: string; consent?: string; doctorId?: string; limit?: number; offset?: number }

/** Search by name, patient ID (e.g. RC-10021) or phone. Merged records are hidden. */
export async function searchPatients(actor: SignedInUser, f: PatientFilter = {}) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patients");
    const where = ["p.merged_into IS NULL"];
    const args: unknown[] = [];
    const q = f.q?.trim();
    if (q) {
      args.push(q);
      const i = args.length;
      const digits = q.replace(/\D/g, "").slice(-10);
      args.push(digits.length >= 4 ? digits : null);
      const j = args.length;
      where.push(`(p.name ILIKE '%' || $${i} || '%' OR similarity(p.name, $${i}) > 0.35 OR upper(p.patient_code) = upper($${i})
                  OR EXISTS (SELECT 1 FROM patients m WHERE m.merged_into = p.id AND upper(m.patient_code) = upper($${i}))
                  OR ($${j}::text IS NOT NULL AND rc_phone_digits(p.phone) LIKE '%' || $${j}::text || '%'))`);
    }
    if (f.consent && ["given", "withdrawn", "not_recorded"].includes(f.consent)) { args.push(f.consent); where.push(`p.consent_status = $${args.length}`); }
    if (f.doctorId) { args.push(f.doctorId); where.push(`p.assigned_doctor_id = $${args.length}`); }
    const limit = Math.min(f.limit ?? 50, 200);
    args.push(limit, f.offset ?? 0);
    const order = q ? `ORDER BY (upper(p.patient_code) = upper($1)) DESC, similarity(p.name, $1) DESC, p.name` : "ORDER BY p.registered_at DESC";
    const r = await c.query(`${SUMMARY_SQL} WHERE ${where.join(" AND ")} ${order} LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const total = (await c.query(`SELECT count(*)::int AS n FROM patients p WHERE ${where.join(" AND ")}`, args.slice(0, -2))).rows[0].n;
    return { patients: r.rows.map(toSummary), total };
  });
}

export async function getPatient(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    if (!z.string().uuid().safeParse(patientId).success) throw new UserError("Patient not found.");
    await requireCap(c, "view_patients");
    const r = await c.query(`${SUMMARY_SQL} WHERE p.id = $1`, [patientId]);
    if (!r.rowCount) throw new UserError("Patient not found.");
    const x = (await c.query("SELECT * FROM patients WHERE id = $1", [patientId])).rows[0];
    let clinical: Patient["clinical"] = null;
    if (await can(c, "view_patient_history")) {
      const cl = (await c.query("SELECT * FROM patient_clinical WHERE patient_id = $1", [patientId])).rows[0];
      clinical = { medicalHistory: cl?.medical_history ?? "", allergies: cl?.allergies ?? "", notes: cl?.notes ?? "" };
      await audit(c, actor, "patient_history_viewed", "patient", patientId);
    }
    return {
      ...toSummary(r.rows[0]), email: x.email, dateOfBirth: x.date_of_birth ?? null,
      address: x.address, assignedDoctorId: x.assigned_doctor_id, firstProblem: x.first_problem, mergedInto: x.merged_into, clinical,
    } as Patient;
  });
}

export async function updateClinical(actor: SignedInUser, patientId: string, input: { medicalHistory?: string; allergies?: string; notes?: string }) {
  return act(actor, async (c) => {
    if (!(await can(c, "view_patient_history")) || !(await can(c, "edit_patient"))) throw new UserError("You don't have permission to edit medical history.");
    const clip = (s?: string) => (s ?? "").trim().slice(0, 10000);
    const exists = (await c.query("SELECT clinic_id FROM patients WHERE id = $1", [patientId])).rows[0];
    if (!exists) throw new UserError("Patient not found.");
    await c.query(
      `INSERT INTO patient_clinical (patient_id, clinic_id, medical_history, allergies, notes) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (patient_id) DO UPDATE SET medical_history=EXCLUDED.medical_history, allergies=EXCLUDED.allergies, notes=EXCLUDED.notes, updated_at=now()`,
      [patientId, actor.clinicId, clip(input.medicalHistory), clip(input.allergies), clip(input.notes)],
    );
    await audit(c, actor, "patient_history_updated", "patient", patientId);
    return null;
  });
}

// ---------- consent ----------
export const CONSENT_METHODS = ["in_person", "signed_form", "verbal", "uploaded_form"] as const;

export async function recordConsent(actor: SignedInUser, patientId: string, input: { status: "given" | "withdrawn"; method: (typeof CONSENT_METHODS)[number]; language?: "en" | "hi"; note?: string }) {
  const wordings = await currentConsentWordings(actor);
  if (!wordings.ok) return wordings;
  const lang = input.language ?? "en";
  const version = `${lang}:${wordings.value.find((w) => w.language === lang)!.version}`;
  return act(actor, async (c) => {
    await requireCap(c, "record_consent", "You don't have permission to record consent.");
    if (!["given", "withdrawn"].includes(input.status)) throw new UserError("Choose given or withdrawn.");
    if (!CONSENT_METHODS.includes(input.method)) throw new UserError("Choose how consent was recorded.", "method");
    const p = (await c.query("SELECT id FROM patients WHERE id = $1 AND merged_into IS NULL", [patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    await c.query(
      "INSERT INTO patient_consents (clinic_id, patient_id, status, method, wording_version, recorded_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [actor.clinicId, patientId, input.status, input.method, version, actor.userId, input.note?.trim().slice(0, 500) || null],
    );
    return null;
  });
}

export async function consentHistory(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT pc.status, pc.method, pc.wording_version, pc.recorded_at, pc.note, u.display_name AS recorded_by
       FROM patient_consents pc LEFT JOIN users u ON u.id = pc.recorded_by WHERE pc.patient_id = $1 ORDER BY pc.recorded_at DESC`,
      [patientId],
    );
    return r.rows.map((x) => ({ status: x.status, method: x.method, wordingVersion: x.wording_version, recordedAt: x.recorded_at, note: x.note, recordedBy: x.recorded_by }));
  });
}

// ---------- duplicates and merge ----------
export async function duplicatesOf(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    const p = (await c.query("SELECT name, phone, date_of_birth, age_years FROM patients WHERE id = $1", [patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    return findDuplicates(c, { name: p.name, phone: p.phone, dateOfBirth: p.date_of_birth ?? null, ageYears: p.age_years }, patientId);
  });
}

export async function mergePatients(actor: SignedInUser, keepId: string, mergeId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "merge_patients", "Only staff allowed to merge patients can do this.");
    try {
      await c.query("SELECT rc_merge_patients($1,$2)", [keepId, mergeId]);
    } catch (e) {
      const m = (e as Error).message;
      if (/not found|cannot be merged/.test(m)) throw new UserError(m === "patients not found" ? "Patient not found." : "These patients can't be merged.");
      throw e;
    }
    return null;
  });
}

// ---------- timeline (appointments, documents, calls, consent) ----------
export interface TimelineItem { at: Date; kind: "appointment" | "document" | "call" | "consent"; title: string; detail: string | null; id: string }

export async function patientTimeline(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT a.starts_at AS at, 'appointment' AS kind, a.id::text, initcap(replace(a.status,'_',' ')) || coalesce(' · ' || s.name, '') AS title,
              concat_ws(' · ', nullif(a.reason, ''), d.display_name) AS detail
         FROM appointments a LEFT JOIN clinic_services s ON s.id = a.service_id LEFT JOIN users d ON d.id = a.doctor_id WHERE a.patient_id = $1
       UNION ALL
       SELECT uploaded_at, 'document', id::text, initcap(doc_type) || coalesce(': ' || original_filename, ''), description FROM documents WHERE patient_id = $1
       UNION ALL
       SELECT started_at, 'call', id::text, initcap(direction) || ' call · ' || replace(status,'_',' ') || CASE WHEN is_simulated THEN ' (simulated)' ELSE '' END, summary
         FROM calls WHERE patient_id = $1
       UNION ALL
       SELECT recorded_at, 'consent', id::text, 'Consent ' || status, replace(method,'_',' ') FROM patient_consents WHERE patient_id = $1
       ORDER BY 1 DESC LIMIT 200`,
      [patientId],
    );
    return r.rows.map((x) => ({ at: x.at, kind: x.kind, id: x.id, title: x.title, detail: x.detail || null })) as TimelineItem[];
  });
}

// ---------- CSV export and import ----------
const EXPORT_COLUMNS = ["patient_id", "name", "phone", "email", "date_of_birth", "age", "gender", "address", "consent", "registered_on"];

export async function exportPatientsCsv(actor: SignedInUser) {
  return act(actor, async (c) => {
    await requireCap(c, "export_data", "You don't have permission to export data.");
    const r = await c.query(
      `SELECT patient_code, name, phone, email, to_char(date_of_birth,'YYYY-MM-DD') AS dob, age_years, gender, address, consent_status,
              to_char(registered_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS reg
       FROM patients WHERE merged_into IS NULL ORDER BY patient_code`,
    );
    await audit(c, actor, "patients_exported", "clinic", actor.clinicId!, { rows: r.rowCount });
    return toCsv(EXPORT_COLUMNS, r.rows.map((x) => [x.patient_code, x.name, x.phone, x.email, x.dob, x.age_years, x.gender, x.address, x.consent_status, x.reg]));
  });
}

export interface ImportReport { created: number; skippedDuplicates: { row: number; name: string; matches: string }[]; errors: { row: number; error: string }[] }

/**
 * Imports patients from CSV (columns: name, phone, email, date_of_birth, age, gender, address; header names are
 * matched loosely). Rows that look like existing patients are skipped and reported, never merged automatically.
 * All rows are checked first; nothing is saved if the file has more than 2,000 rows.
 */
export async function importPatientsCsv(actor: SignedInUser, csvText: string) {
  return act(actor, async (c): Promise<ImportReport> => {
    await requireCap(c, "import_patients", "You don't have permission to import patients.");
    await requireCap(c, "edit_patient");
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new UserError("The file has no patient rows.");
    if (rows.length > 2001) throw new UserError("Import up to 2,000 patients at a time.");
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
    const idx = {
      name: col("name", "patientname", "fullname"), phone: col("phone", "mobile", "phonenumber", "mobilenumber", "contact"),
      email: col("email", "emailaddress"), dob: col("dateofbirth", "dob", "birthdate"), age: col("age"),
      gender: col("gender", "sex"), address: col("address"),
    };
    if (idx.name < 0) throw new UserError("The file needs a 'name' column.");
    const report: ImportReport = { created: 0, skippedDuplicates: [], errors: [] };
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.every((v) => !v.trim())) continue;
      const get = (k: number) => (k >= 0 ? (row[k] ?? "").trim() : "");
      const p = patientSchema.safeParse({
        name: get(idx.name), phone: get(idx.phone), email: get(idx.email), dateOfBirth: normaliseDate(get(idx.dob)),
        ageYears: get(idx.age), gender: get(idx.gender), address: get(idx.address),
      });
      if (!p.success) { report.errors.push({ row: i + 1, error: p.error.issues[0].message }); continue; }
      const dups = await findDuplicates(c, p.data);
      if (dups.length) { report.skippedDuplicates.push({ row: i + 1, name: p.data.name, matches: dups.map((d) => d.code).join(", ") }); continue; }
      const d = p.data;
      await c.query(
        "INSERT INTO patients (clinic_id, name, phone, email, date_of_birth, age_years, gender, address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [actor.clinicId, d.name, d.phone, d.email, d.dateOfBirth, d.ageYears, d.gender, d.address],
      );
      report.created++;
    }
    await audit(c, actor, "patients_imported", "clinic", actor.clinicId!, { created: report.created, skipped: report.skippedDuplicates.length, errors: report.errors.length });
    return report;
  });
}

/** Accepts YYYY-MM-DD or DD/MM/YYYY (Indian order) or DD-MM-YYYY. */
function normaliseDate(v: string): string {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : v;
}

/** Active doctors, for pickers. */
export async function listDoctors(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query("SELECT id, display_name FROM users WHERE role = 'doctor' AND status = 'active' ORDER BY display_name");
    return r.rows.map((x) => ({ id: x.id as string, name: x.display_name as string }));
  });
}
