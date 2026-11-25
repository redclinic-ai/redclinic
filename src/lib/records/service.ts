// Patient records (V2): visits, conditions, medicines, allergies, lab values, and reading documents into them.
// Everything a doctor sees here links back to where it came from: a visit note, a document line, or a person.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, firstIssue, requireCap, UserError } from "../authz";
import { getStorage } from "../storage";
import { getExtractor } from "./extract-text";
import { suggest, type Suggestion } from "./suggest";

const uuid = z.string().uuid();
const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
async function patientExists(c: PoolClient, patientId: string) {
  if (!uuid.safeParse(patientId).success) throw new UserError("Patient not found.");
  const p = (await c.query("SELECT id FROM patients WHERE id = $1 AND merged_into IS NULL", [patientId])).rows[0];
  if (!p) throw new UserError("Patient not found.");
}

// ---------- the record ----------

export async function patientRecord(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patient_history");
    await patientExists(c, patientId);
    const q = (sql: string) => c.query(sql, [patientId]).then((r) => r.rows);
    const [conditions, medications, allergies, labs, visits, docs] = await Promise.all([
      q(`SELECT x.*, u.display_name AS by FROM patient_conditions x LEFT JOIN users u ON u.id = x.created_by WHERE x.patient_id = $1 AND x.status <> 'entered_in_error' ORDER BY x.status, x.created_at DESC`),
      q(`SELECT x.*, u.display_name AS by FROM patient_medications x LEFT JOIN users u ON u.id = x.created_by WHERE x.patient_id = $1 AND x.status <> 'entered_in_error' ORDER BY (x.status = 'active') DESC, x.created_at DESC LIMIT 100`),
      q(`SELECT x.*, u.display_name AS by FROM patient_allergies x LEFT JOIN users u ON u.id = x.created_by WHERE x.patient_id = $1 AND x.status = 'active' ORDER BY x.created_at DESC`),
      q(`SELECT x.* FROM lab_results x WHERE x.patient_id = $1 AND x.status = 'active' ORDER BY x.test_name, x.taken_on DESC NULLS LAST, x.created_at DESC LIMIT 300`),
      q(`SELECT v.id, v.visit_date, v.status, v.diagnosis, v.chief_complaint, v.is_online, u.display_name AS doctor FROM visit_notes v LEFT JOIN users u ON u.id = v.doctor_id
          WHERE v.patient_id = $1 ORDER BY v.visit_date DESC, v.created_at DESC LIMIT 50`),
      q(`SELECT id, original_filename, doc_type FROM documents WHERE patient_id = $1`),
    ]);
    const docName = new Map(docs.map((d) => [d.id, d.original_filename ?? d.doc_type]));
    const src = (x: Record<string, any>) => ({ source: x.source as string, documentId: x.document_id as string | null, documentName: x.document_id ? docName.get(x.document_id) ?? "document" : null,
      visitId: (x.visit_id ?? null) as string | null, evidence: x.evidence as string | null, by: x.by as string | null, at: x.created_at as Date });
    // lab values grouped by test, newest first, so a trend is visible
    const labGroups = new Map<string, { id: string; value: string; unit: string | null; range: string | null; flag: string | null; takenOn: string | null; source: ReturnType<typeof src> }[]>();
    for (const l of labs) {
      const k = l.test_name.toLowerCase();
      if (!labGroups.has(k)) labGroups.set(k, []);
      labGroups.get(k)!.push({ id: l.id, value: l.value, unit: l.unit, range: l.reference_range, flag: l.flag, takenOn: l.taken_on ? String(l.taken_on).slice(0, 10) : null, source: src(l) });
    }
    await audit(c, actor, "patient_record_viewed", "patient", patientId);
    return {
      conditions: conditions.map((x) => ({ id: x.id, name: x.name, status: x.status, since: x.since, notes: x.notes, ...src(x) })),
      medications: medications.map((x) => ({ id: x.id, name: x.name, strength: x.strength, dose: x.dose, frequency: x.frequency, duration: x.duration, route: x.route,
        instructions: x.instructions, status: x.status, startDate: x.start_date ? String(x.start_date).slice(0, 10) : null, ...src(x) })),
      allergies: allergies.map((x) => ({ id: x.id, substance: x.substance, reaction: x.reaction, severity: x.severity, ...src(x) })),
      labs: [...labGroups.entries()].map(([, rows]) => ({ testName: labs.find((l) => l.id === rows[0].id)!.test_name as string, rows })),
      visits: visits.map((v) => ({ id: v.id, date: String(v.visit_date).slice(0, 10), status: v.status, diagnosis: v.diagnosis, complaint: v.chief_complaint, online: v.is_online, doctor: v.doctor })),
    };
  });
}

const ConditionInput = z.object({ name: z.string().trim().min(2, "Enter the condition.").max(200), since: opt(60), notes: opt(1000) });
const MedicationInput = z.object({
  name: z.string().trim().min(2, "Enter the medicine.").max(200), strength: opt(60), dose: opt(60), frequency: opt(60), duration: opt(60),
  route: opt(40), instructions: opt(300),
});
const AllergyInput = z.object({ substance: z.string().trim().min(2, "Enter what the patient is allergic to.").max(120), reaction: opt(300),
  severity: z.enum(["mild", "moderate", "severe", "unknown"]).default("unknown") });
const LabInput = z.object({ testName: z.string().trim().min(2, "Enter the test.").max(120), value: z.string().trim().min(1, "Enter the value.").max(60),
  unit: opt(30), range: opt(60), takenOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date.").optional().or(z.literal("")).transform((v) => v || null) });

export type RecordKind = "condition" | "medication" | "allergy" | "lab";

/** Staff add an item by hand (source "manual"). */
export async function addRecordItem(actor: SignedInUser, patientId: string, kind: RecordKind, input: Record<string, string>) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical", "Only doctors (or staff with clinical permission) can change the record.");
    await patientExists(c, patientId);
    const id = await insertItem(c, actor, patientId, kind, input, { source: "manual" });
    await audit(c, actor, `record_${kind}_added`, "patient", patientId, { id });
    return id;
  });
}

async function insertItem(c: PoolClient, actor: SignedInUser, patientId: string, kind: RecordKind, input: Record<string, string>,
                          from: { source: "manual" | "visit" | "document"; documentId?: string; visitId?: string; evidence?: string; date?: string | null }) {
  const base = [actor.clinicId, patientId, from.source, from.documentId ?? null, from.evidence ?? null, actor.userId];
  if (kind === "condition") {
    const p = ConditionInput.safeParse(input); if (!p.success) throw firstIssue(p.error);
    return (await c.query(`INSERT INTO patient_conditions (clinic_id, patient_id, source, document_id, evidence, created_by, name, since, notes, visit_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [...base, p.data.name, p.data.since, p.data.notes, from.visitId ?? null])).rows[0].id as string;
  }
  if (kind === "medication") {
    const p = MedicationInput.safeParse(input); if (!p.success) throw firstIssue(p.error);
    const v = p.data;
    return (await c.query(`INSERT INTO patient_medications (clinic_id, patient_id, source, document_id, evidence, created_by, name, strength, dose, frequency, duration, route, instructions, visit_id, prescribed_by, start_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [...base, v.name, v.strength, v.dose, v.frequency, v.duration, v.route, v.instructions, from.visitId ?? null, from.source === "visit" ? actor.userId : null, from.date ?? null])).rows[0].id as string;
  }
  if (kind === "allergy") {
    const p = AllergyInput.safeParse(input); if (!p.success) throw firstIssue(p.error);
    return (await c.query(`INSERT INTO patient_allergies (clinic_id, patient_id, source, document_id, evidence, created_by, substance, reaction, severity)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [...base, p.data.substance, p.data.reaction, p.data.severity])).rows[0].id as string;
  }
  const p = LabInput.safeParse({ testName: input.testName ?? input.test_name, value: input.value, unit: input.unit, range: input.range ?? input.reference_range, takenOn: input.takenOn ?? from.date ?? "" });
  if (!p.success) throw firstIssue(p.error);
  const v = p.data;
  let flag: string | null = input.flag && ["normal", "high", "low", "abnormal"].includes(input.flag) ? input.flag : null;
  if (!flag && v.range && /^\s*[\d.]+\s*[-–]\s*[\d.]+\s*$/.test(v.range) && !isNaN(Number(v.value))) {
    const [lo, hi] = v.range.split(/[-–]/).map(Number); const n = Number(v.value);
    flag = n < lo ? "low" : n > hi ? "high" : "normal";
  }
  return (await c.query(`INSERT INTO lab_results (clinic_id, patient_id, source, document_id, evidence, created_by, test_name, value, unit, reference_range, flag, taken_on)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [...base.slice(0, 2), from.source === "visit" ? "manual" : from.source, ...base.slice(3), v.testName, v.value, v.unit, v.range, flag, v.takenOn])).rows[0].id as string;
}

const TABLE: Record<RecordKind, string> = { condition: "patient_conditions", medication: "patient_medications", allergy: "patient_allergies", lab: "lab_results" };
const STATUSES: Record<RecordKind, string[]> = { condition: ["active", "resolved", "entered_in_error"], medication: ["active", "completed", "stopped", "entered_in_error"], allergy: ["active", "entered_in_error"], lab: ["active", "entered_in_error"] };

/** Change status (resolved, stopped, or "entered in error" — nothing is deleted). */
export async function setRecordItemStatus(actor: SignedInUser, kind: RecordKind, id: string, status: string) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical", "Only doctors (or staff with clinical permission) can change the record.");
    if (!TABLE[kind] || !STATUSES[kind].includes(status)) throw new UserError("Unknown change.");
    if (!uuid.safeParse(id).success) throw new UserError("Not found.");
    const r = await c.query(`UPDATE ${TABLE[kind]} SET status = $2 WHERE id = $1 RETURNING patient_id`, [id, status]);
    if (!r.rowCount) throw new UserError("Not found.");
    await audit(c, actor, `record_${kind}_${status}`, "patient", r.rows[0].patient_id, { id });
    return r.rows[0].patient_id as string;
  });
}

// ---------- visits ----------

const Vitals = z.object({
  bp_systolic: z.coerce.number().int().min(50).max(260).optional(), bp_diastolic: z.coerce.number().int().min(30).max(160).optional(),
  pulse: z.coerce.number().int().min(20).max(250).optional(), temperature_c: z.coerce.number().min(30).max(45).optional(),
  weight_kg: z.coerce.number().min(0.5).max(300).optional(), height_cm: z.coerce.number().min(30).max(250).optional(),
  spo2: z.coerce.number().int().min(50).max(100).optional(),
});
const VisitInput = z.object({
  chiefComplaint: opt(1000), findings: opt(4000), diagnosis: opt(1000), advice: opt(4000), followUp: opt(500),
  vitals: z.record(z.string(), z.string()).transform((v): Record<string, unknown> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ""))).pipe(Vitals),
});

export async function startVisit(actor: SignedInUser, input: { patientId: string; appointmentId?: string | null }) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical", "Only doctors (or staff with clinical permission) can write visit notes.");
    await patientExists(c, input.patientId);
    if (input.appointmentId) {
      const existing = (await c.query("SELECT id FROM visit_notes WHERE appointment_id = $1", [input.appointmentId])).rows[0];
      if (existing) return existing.id as string;
      const a = (await c.query("SELECT patient_id, appointment_type FROM appointments WHERE id = $1", [input.appointmentId])).rows[0];
      if (!a || a.patient_id !== input.patientId) throw new UserError("That appointment is not this patient's.");
    }
    const online = input.appointmentId ? (await c.query("SELECT appointment_type = 'online' AS o FROM appointments WHERE id = $1", [input.appointmentId])).rows[0]?.o : false;
    const id = (await c.query(
      `INSERT INTO visit_notes (clinic_id, patient_id, appointment_id, doctor_id, is_online, created_by) VALUES ($1,$2,$3,$4,$5,$4) RETURNING id`,
      [actor.clinicId, input.patientId, input.appointmentId ?? null, actor.userId, !!online])).rows[0].id as string;
    await audit(c, actor, "visit_started", "visit", id, { patientId: input.patientId });
    return id;
  });
}

export async function getVisit(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patient_history");
    if (!uuid.safeParse(id).success) throw new UserError("Visit not found.");
    const v = (await c.query(
      `SELECT v.*, u.display_name AS doctor, p.name AS patient_name, p.patient_code, p.age_years, p.gender, p.phone, cl.name AS clinic_name, cl.address AS clinic_address, cl.phone AS clinic_phone
         FROM visit_notes v JOIN patients p ON p.id = v.patient_id JOIN clinics cl ON cl.id = v.clinic_id LEFT JOIN users u ON u.id = v.doctor_id WHERE v.id = $1`, [id])).rows[0];
    if (!v) throw new UserError("Visit not found.");
    const meds = (await c.query("SELECT * FROM patient_medications WHERE visit_id = $1 AND status <> 'entered_in_error' ORDER BY created_at", [id])).rows;
    const allergies = (await c.query("SELECT substance, reaction FROM patient_allergies WHERE patient_id = $1 AND status = 'active'", [v.patient_id])).rows;
    return {
      id: v.id, patientId: v.patient_id, patientName: v.patient_name, patientCode: v.patient_code, age: v.age_years, gender: v.gender, phone: v.phone,
      appointmentId: v.appointment_id, doctor: v.doctor, doctorId: v.doctor_id, date: String(v.visit_date).slice(0, 10), online: v.is_online,
      chiefComplaint: v.chief_complaint ?? "", findings: v.findings ?? "", diagnosis: v.diagnosis ?? "", advice: v.advice ?? "", followUp: v.follow_up ?? "",
      vitals: v.vitals as Record<string, number>, status: v.status as "draft" | "signed", signedAt: v.signed_at, addenda: v.addenda as { at: string; by: string; text: string }[],
      clinic: { name: v.clinic_name, address: v.clinic_address, phone: v.clinic_phone },
      medications: meds.map((m) => ({ id: m.id, name: m.name, strength: m.strength, dose: m.dose, frequency: m.frequency, duration: m.duration, route: m.route, instructions: m.instructions })),
      allergies: allergies.map((a) => (a.reaction ? `${a.substance} (${a.reaction})` : a.substance)),
    };
  });
}

export async function saveVisit(actor: SignedInUser, id: string, input: { chiefComplaint?: string; findings?: string; diagnosis?: string; advice?: string; followUp?: string; vitals: Record<string, string> }) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical");
    const p = VisitInput.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const v = p.data;
    const cur = (await c.query("SELECT status FROM visit_notes WHERE id = $1", [id])).rows[0];
    if (!cur) throw new UserError("Visit not found.");
    if (cur.status === "signed") throw new UserError("This note is signed. Add a correction instead.");
    await c.query(
      `UPDATE visit_notes SET chief_complaint=$2, findings=$3, diagnosis=$4, advice=$5, follow_up=$6, vitals=$7, updated_at=now() WHERE id=$1`,
      [id, v.chiefComplaint, v.findings, v.diagnosis, v.advice, v.followUp, v.vitals]);
    return id;
  });
}

export async function addVisitMedication(actor: SignedInUser, visitId: string, input: Record<string, string>) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical");
    const v = (await c.query("SELECT patient_id, status, visit_date FROM visit_notes WHERE id = $1", [visitId])).rows[0];
    if (!v) throw new UserError("Visit not found.");
    if (v.status === "signed") throw new UserError("This note is signed. Add a correction instead.");
    return insertItem(c, actor, v.patient_id, "medication", input, { source: "visit", visitId, date: String(v.visit_date).slice(0, 10) });
  });
}

/** Signing locks the note; the diagnosis also goes on the patient's condition list. */
export async function signVisit(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical");
    const v = (await c.query("SELECT * FROM visit_notes WHERE id = $1", [id])).rows[0];
    if (!v) throw new UserError("Visit not found.");
    if (v.status === "signed") return id;
    if (!v.diagnosis && !v.findings && !v.chief_complaint) throw new UserError("Write at least the complaint, findings or diagnosis before signing.");
    await c.query("UPDATE visit_notes SET status='signed', signed_at=now(), updated_at=now() WHERE id=$1", [id]);
    if (v.diagnosis) {
      for (const name of String(v.diagnosis).split(/[;\n]/).map((s: string) => s.trim()).filter((s: string) => s.length >= 2).slice(0, 5)) {
        const dup = (await c.query("SELECT 1 FROM patient_conditions WHERE patient_id = $1 AND lower(name) = lower($2) AND status = 'active'", [v.patient_id, name])).rowCount;
        if (!dup) await c.query(`INSERT INTO patient_conditions (clinic_id, patient_id, name, source, visit_id, created_by) VALUES ($1,$2,$3,'visit',$4,$5)`,
          [actor.clinicId, v.patient_id, name.slice(0, 200), id, actor.userId]);
      }
    }
    await audit(c, actor, "visit_signed", "visit", id);
    return id;
  });
}

export async function addAddendum(actor: SignedInUser, id: string, text: string) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical");
    const t = text.trim();
    if (t.length < 3 || t.length > 2000) throw new UserError("Write the correction (up to 2,000 characters).", "text");
    const r = await c.query(
      `UPDATE visit_notes SET addenda = addenda || jsonb_build_array(jsonb_build_object('at', now(), 'by', $2::text, 'text', $3::text)) WHERE id = $1 AND status = 'signed' RETURNING id`,
      [id, actor.displayName, t]);
    if (!r.rowCount) throw new UserError("Corrections are added to signed notes. Edit the draft instead.");
    await audit(c, actor, "visit_addendum", "visit", id);
    return id;
  });
}

// ---------- reading documents ----------

const READABLE = ["application/pdf", "image/jpeg", "image/png"];

export async function readDocument(actor: SignedInUser, documentId: string) {
  return act(actor, async (c) => {
    if (!(await can(c, "write_clinical")) && !(await can(c, "upload_document"))) throw new UserError("You don't have permission to read documents into the record.");
    await requireCap(c, "view_documents");
    if (!uuid.safeParse(documentId).success) throw new UserError("Document not found.");
    const d = (await c.query("SELECT * FROM documents WHERE id = $1", [documentId])).rows[0];
    if (!d) throw new UserError("Document not found.");
    if (!d.storage_path || !READABLE.includes(d.mime_type)) throw new UserError("Only PDFs and JPEG or PNG photos can be read.");
    const existing = (await c.query("SELECT id, status FROM document_extractions WHERE document_id = $1", [documentId])).rows[0];
    if (existing && existing.status !== "failed") return existing.id as string;
    let row: { status: string; method: string; text: string | null; pages: number | null; confidence: number | null; items: Suggestion[]; error: string | null; language: string | null };
    try {
      const bytes = await getStorage().get(d.storage_path);
      const t = await getExtractor().extract(bytes, d.mime_type);
      const text = t.pages.map((p) => p.text).join("\n\n").slice(0, 200_000);
      if (text.trim().length < 5) {
        row = { status: "failed", method: t.method, text, pages: t.pages.length, confidence: t.confidence, items: [], language: t.language,
          error: d.mime_type === "application/pdf" ? "This PDF has no text layer (it is a scan). Upload a photo of the page to read it." : "No readable text was found. Try a clearer photo." };
      } else {
        const s = suggest(t.pages);
        row = { status: "ready", method: t.method, text, pages: t.pages.length, confidence: t.confidence, items: s.items.map((i) => ({ ...i, fields: { ...i.fields, ...(s.documentDate ? { _date: s.documentDate } : {}) } })), language: t.language, error: null };
      }
    } catch (e) {
      row = { status: "failed", method: "none", text: null, pages: null, confidence: null, items: [], language: null, error: `The document could not be read: ${(e as Error).message.slice(0, 200)}` };
    }
    const id = (await c.query(
      `INSERT INTO document_extractions (clinic_id, document_id, patient_id, status, method, language, pages, confidence, text, items, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (document_id) DO UPDATE SET status=$4, method=$5, language=$6, pages=$7, confidence=$8, text=$9, items=$10, error=$11, created_at=now()
       RETURNING id`,
      [actor.clinicId, documentId, d.patient_id, row.status, row.method, row.language, row.pages, row.confidence, row.text, JSON.stringify(row.items), row.error])).rows[0].id as string;
    await audit(c, actor, "document_read", "document", documentId, { status: row.status, items: row.items.length, method: row.method });
    return id;
  });
}

export async function getExtraction(actor: SignedInUser, documentId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "view_patient_history");
    if (!uuid.safeParse(documentId).success) throw new UserError("Document not found.");
    const x = (await c.query(
      `SELECT x.*, d.original_filename, d.doc_type, d.mime_type, d.uploaded_at, u.display_name AS reviewer FROM document_extractions x
         JOIN documents d ON d.id = x.document_id LEFT JOIN users u ON u.id = x.reviewed_by WHERE x.document_id = $1`, [documentId])).rows[0];
    if (!x) return null;
    return {
      id: x.id, documentId, patientId: x.patient_id, fileName: x.original_filename ?? x.doc_type, status: x.status as string, method: x.method as string,
      confidence: x.confidence === null ? null : Number(x.confidence), text: (x.text ?? "") as string, error: x.error as string | null,
      items: x.items as Suggestion[], reviewer: x.reviewer as string | null, reviewedAt: x.reviewed_at as Date | null,
    };
  });
}

/** The doctor's decision: the ticked suggestions (as edited) go into the record, with the document as their source. */
export async function confirmExtraction(actor: SignedInUser, documentId: string, chosen: { key: string; fields: Record<string, string> }[]) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical", "Only doctors (or staff with clinical permission) can add items to the record.");
    const x = (await c.query("SELECT * FROM document_extractions WHERE document_id = $1 FOR UPDATE", [documentId])).rows[0];
    if (!x) throw new UserError("Read the document first.");
    if (x.status !== "ready") throw new UserError(x.status === "confirmed" ? "This document was already reviewed." : "There is nothing to confirm.");
    const items = new Map((x.items as Suggestion[]).map((i) => [i.key, i]));
    const added: string[] = [];
    for (const ch of chosen) {
      const s = items.get(ch.key);
      if (!s) continue;
      const fields = { ...s.fields, ...ch.fields };
      const date = fields._date ?? null;
      delete fields._date;
      added.push(await insertItem(c, actor, x.patient_id, s.kind, fields, { source: "document", documentId, evidence: `Page ${s.evidence.page}, line ${s.evidence.line}: ${s.evidence.text}`, date }));
    }
    await c.query("UPDATE document_extractions SET status='confirmed', reviewed_by=$2, reviewed_at=now() WHERE id=$1", [x.id, actor.userId]);
    await audit(c, actor, "document_items_confirmed", "document", documentId, { added: added.length, suggested: items.size });
    return added.length;
  });
}

export async function dismissExtraction(actor: SignedInUser, documentId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "write_clinical");
    const r = await c.query("UPDATE document_extractions SET status='dismissed', reviewed_by=$2, reviewed_at=now() WHERE document_id=$1 AND status='ready' RETURNING id", [documentId, actor.userId]);
    if (!r.rowCount) throw new UserError("There is nothing to dismiss.");
    await audit(c, actor, "document_items_dismissed", "document", documentId);
    return true;
  });
}
