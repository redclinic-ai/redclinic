// V2: medical record (visits, conditions, medicines, allergies, test values), reading documents into it, online consultations.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { closePool } from "@/lib/db";
import { uploadDocument } from "@/lib/documents/service";
import { addRecordItem, addAddendum, addVisitMedication, confirmExtraction, getExtraction, getVisit, patientRecord, readDocument, saveVisit, setRecordItemStatus, signVisit, startVisit } from "@/lib/records/service";
import { OpenSourceExtractor, SimulatedExtractor, setExtractor } from "@/lib/records/extract-text";
import { makeInClinic, makeOnline, onlineDetails, saveTelehealth, sendJoinLink } from "@/lib/telehealth/service";
import { addStaff, freshOutbox, newClinic, newPatient } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); setExtractor(undefined); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { setExtractor(undefined); await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const FIX = (f: string) => readFileSync(path.resolve(import.meta.dirname, "fixtures", f));
const RX_TEXT = readFileSync(path.resolve(import.meta.dirname, "fixtures", "prescription.pdf")).length ? `Dr. R. Rao
Date: 12/11/2026
Diagnosis: Irreversible pulpitis 36
Allergy: Penicillin (rash)
Rx
1. Tab Amoxicillin 500 mg 1-0-1 x 5 days after food
2. Tab Ibuprofen 400 mg TDS x 3 days
Haemoglobin 11.2 g/dL (12.0 - 15.5)` : "";

async function setup() {
  const c = await newClinic();
  const doctor = await addStaff(c.admin, "doctor", outbox);
  const recep = await addStaff(c.admin, "receptionist", outbox);
  const patientId = await newPatient(c.admin, "Asha Kumar");
  return { ...c, doctor, recep, patientId };
}

describe("medical record", () => {
  it("doctors write it; receptionists cannot read or change it; nothing is deleted, only marked", async () => {
    const s = await setup();
    expect((await patientRecord(s.recep, s.patientId)).ok).toBe(false);
    expect((await addRecordItem(s.recep, s.patientId, "allergy", { substance: "Penicillin" })).ok).toBe(false);
    const a = ok(await addRecordItem(s.doctor, s.patientId, "allergy", { substance: "Penicillin", reaction: "rash", severity: "moderate" }));
    ok(await addRecordItem(s.doctor, s.patientId, "condition", { name: "Type 2 diabetes", since: "2019" }));
    const m = ok(await addRecordItem(s.doctor, s.patientId, "medication", { name: "Metformin", strength: "500 mg", frequency: "1-0-1" }));
    ok(await addRecordItem(s.doctor, s.patientId, "lab", { testName: "HbA1c", value: "7.9", unit: "%", range: "4.0-5.6", takenOn: "2026-10-01" }));
    ok(await addRecordItem(s.doctor, s.patientId, "lab", { testName: "HbA1c", value: "8.4", unit: "%", range: "4.0-5.6", takenOn: "2026-06-01" }));
    expect((await addRecordItem(s.doctor, s.patientId, "lab", { testName: "HbA1c", value: "" })).ok).toBe(false);
    let r = ok(await patientRecord(s.doctor, s.patientId));
    expect(r.allergies[0]).toMatchObject({ substance: "Penicillin", source: "manual", by: "Test doctor" });
    expect(r.labs[0]).toMatchObject({ testName: "HbA1c", rows: [{ value: "7.9", flag: "high", takenOn: "2026-10-01" }, { value: "8.4" }] });
    ok(await setRecordItemStatus(s.doctor, "medication", m, "stopped"));
    ok(await setRecordItemStatus(s.doctor, "allergy", a, "entered_in_error"));
    r = ok(await patientRecord(s.doctor, s.patientId));
    expect(r.allergies).toHaveLength(0);
    expect(r.medications[0].status).toBe("stopped");
    await expect(owner.query("SET ROLE rc_app; DELETE FROM patient_allergies; RESET ROLE;")).rejects.toThrow(/permission denied/);
    await owner.query("RESET ROLE");
    // another clinic sees nothing
    const other = await newClinic();
    expect((await patientRecord(other.admin, s.patientId)).ok).toBe(false);
  });

  it("a visit note: vitals checked, prescription added, signing locks it and adds the diagnosis to conditions", async () => {
    const s = await setup();
    expect((await startVisit(s.recep, { patientId: s.patientId })).ok).toBe(false);
    const v = ok(await startVisit(s.doctor, { patientId: s.patientId }));
    expect((await saveVisit(s.doctor, v, { vitals: { bp_systolic: "500" } })).ok).toBe(false);
    ok(await saveVisit(s.doctor, v, { chiefComplaint: "Pain lower left tooth", diagnosis: "Irreversible pulpitis 36", advice: "Warm saline rinses", vitals: { bp_systolic: "128", bp_diastolic: "82", pulse: "" } }));
    ok(await addVisitMedication(s.doctor, v, { name: "Amoxicillin", strength: "500 mg", frequency: "1-0-1", duration: "5 days", instructions: "after food" }));
    expect((await signVisit(s.recep, v)).ok).toBe(false);
    ok(await signVisit(s.doctor, v));
    const got = ok(await getVisit(s.doctor, v));
    expect(got).toMatchObject({ status: "signed", vitals: { bp_systolic: 128, bp_diastolic: 82 }, medications: [{ name: "Amoxicillin", frequency: "1-0-1" }] });
    expect((await saveVisit(s.doctor, v, { diagnosis: "changed", vitals: {} })).ok).toBe(false);
    expect((await addVisitMedication(s.doctor, v, { name: "Ibuprofen" })).ok).toBe(false);
    await expect(owner.query("UPDATE visit_notes SET diagnosis = 'x' WHERE id = $1", [v])).rejects.toThrow(/signed visit note cannot be changed/);
    ok(await addAddendum(s.doctor, v, "Patient reports no allergy to amoxicillin."));
    expect(ok(await getVisit(s.doctor, v)).addenda).toHaveLength(1);
    const rec = ok(await patientRecord(s.doctor, s.patientId));
    expect(rec.conditions[0]).toMatchObject({ name: "Irreversible pulpitis 36", source: "visit", visitId: v });
    expect(rec.medications[0]).toMatchObject({ name: "Amoxicillin", source: "visit", visitId: v });
  });
});

describe("reading documents", () => {
  async function upload(s: Awaited<ReturnType<typeof setup>>, file: string, name: string) {
    return ok(await uploadDocument(s.recep, { patientId: s.patientId, docType: "prescription", file: { name, bytes: FIX(file) } })).documentId;
  }

  it("suggests items with their source line; only ticked (and edited) items go into the record", async () => {
    const s = await setup();
    const doc = await upload(s, "prescription-photo.png", "rx.png");
    setExtractor(new SimulatedExtractor(RX_TEXT));
    expect((await readDocument(s.recep, doc)).ok).toBe(false);   // receptionists can upload but not open documents
    ok(await readDocument(s.doctor, doc));
    expect((await getExtraction(s.recep, doc)).ok).toBe(false);
    const x = ok(await getExtraction(s.doctor, doc))!;
    expect(x.items.map((i) => i.kind)).toEqual(["condition", "allergy", "medication", "medication", "lab"]);
    const amox = x.items.find((i) => i.fields.name === "Amoxicillin")!;
    expect(amox.evidence).toMatchObject({ page: 1, text: expect.stringContaining("Tab Amoxicillin 500 mg") });
    const allergy = x.items.find((i) => i.kind === "allergy")!;
    const lab = x.items.find((i) => i.kind === "lab")!;
    expect((await confirmExtraction(s.recep, doc, [{ key: amox.key, fields: {} }])).ok).toBe(false);
    expect(ok(await confirmExtraction(s.doctor, doc, [{ key: amox.key, fields: { duration: "7 days" } }, { key: allergy.key, fields: {} }, { key: lab.key, fields: {} }]))).toBe(3);
    expect((await confirmExtraction(s.doctor, doc, [])).ok).toBe(false);     // reviewed once
    const r = ok(await patientRecord(s.doctor, s.patientId));
    expect(r.medications[0]).toMatchObject({ name: "Amoxicillin", duration: "7 days", source: "document", documentId: doc, startDate: "2026-11-12", evidence: expect.stringMatching(/^Page 1, line \d+: 1\. Tab Amoxicillin/) });
    expect(r.allergies[0]).toMatchObject({ substance: "Penicillin", reaction: "rash", documentName: "rx.png" });
    expect(r.labs[0].rows[0]).toMatchObject({ value: "11.2", flag: "low", takenOn: "2026-11-12" });
    expect(r.conditions).toHaveLength(0);      // not ticked
  });

  it("explains when nothing can be read", async () => {
    const s = await setup();
    const doc = await upload(s, "prescription-photo.png", "blank.png");
    setExtractor(new SimulatedExtractor("  "));
    ok(await readDocument(s.doctor, doc));
    expect(ok(await getExtraction(s.doctor, doc))).toMatchObject({ status: "failed", error: expect.stringMatching(/clearer photo/) });
  });

  it("reads a real digital PDF and a real photo on this server (pdf.js and Tesseract, no internet)", async () => {
    const s = await setup();
    setExtractor(new OpenSourceExtractor());
    const pdf = await upload(s, "prescription.pdf", "rx.pdf");
    ok(await readDocument(s.doctor, pdf));
    const a = ok(await getExtraction(s.doctor, pdf))!;
    expect(a).toMatchObject({ status: "ready", method: "pdf_text" });
    expect(a.items.find((i) => i.kind === "medication")?.fields.name).toBe("Amoxicillin");
    const photo = await upload(s, "prescription-photo.png", "rx-photo.png");
    ok(await readDocument(s.doctor, photo));
    const b = ok(await getExtraction(s.doctor, photo))!;
    expect(b.method).toBe("ocr");
    expect(b.confidence).toBeGreaterThan(70);
    expect(b.items.map((i) => i.fields.name ?? i.fields.substance ?? i.fields.test_name)).toEqual(expect.arrayContaining(["Amoxicillin", "Ibuprofen", "Penicillin"]));
  }, 120_000);
});

describe("online consultations", () => {
  it("needs the clinic to switch it on; gives each appointment a private room; no WhatsApp means no link sending", async () => {
    const s = await setup();
    const appt = (await owner.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status) VALUES ($1,$2,$3, now() + interval '1 day', now() + interval '1 day 20 min', 'scheduled') RETURNING id`,
      [s.clinicId, s.patientId, s.doctor.userId])).rows[0].id;
    expect((await makeOnline(s.recep, appt)).ok).toBe(false);
    expect((await saveTelehealth(s.admin, { enabled: true, jitsiDomain: "https://x" })).ok).toBe(false);
    ok(await saveTelehealth(s.admin, { enabled: true, jitsiDomain: "meet.jit.si" }));
    const { url } = ok(await makeOnline(s.recep, appt));
    expect(url).toMatch(/^https:\/\/meet\.jit\.si\/RedClinic-[0-9a-f]{32}$/);
    expect(ok(await makeOnline(s.recep, appt)).url).toBe(url);     // same room if asked again
    expect(ok(await onlineDetails(s.doctor, appt))).toMatchObject({ online: true, url, publicService: true });
    expect(await sendJoinLink(s.recep, appt)).toMatchObject({ ok: false, error: expect.stringMatching(/WhatsApp is not connected/) });
    const v = ok(await startVisit(s.doctor, { patientId: s.patientId, appointmentId: appt }));
    expect(ok(await getVisit(s.doctor, v)).online).toBe(true);
    expect(ok(await startVisit(s.doctor, { patientId: s.patientId, appointmentId: appt }))).toBe(v);   // one note per appointment
    ok(await makeInClinic(s.recep, appt));
    expect(ok(await onlineDetails(s.doctor, appt))).toMatchObject({ online: false, url: null });
  });
});
