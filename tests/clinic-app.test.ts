import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { closePool, withContext } from "@/lib/db";
import { contextOf } from "@/lib/auth/service";
import { currentConsentWordings, deleteFaq, getClinic, listFaqs, listServices, saveConsentWording, saveFaq, saveService, updateClinicProfile } from "@/lib/clinic/service";
import { listCapabilities, listStaff, setStaffCapabilities } from "@/lib/staff/service";
import {
  consentHistory, duplicatesOf, exportPatientsCsv, getPatient, importPatientsCsv, mergePatients, patientTimeline,
  recordConsent, registerPatient, searchPatients, updateClinical, updatePatient,
} from "@/lib/patients/service";
import { parseCsv } from "@/lib/patients/csv";
import {
  bookAppointment, bookWalkIn, clinicToday, getAppointment, listAppointments, rescheduleAppointment, setAppointmentStatus,
} from "@/lib/appointments/service";
import { uploadDocument } from "@/lib/documents/service";
import { addStaff, freshOutbox, newClinic } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
const owner = new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username, ...(process.env.TEST_DATABASE_ADMIN_URL ? { connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") } : {}) });
afterAll(async () => { await closePool(); await owner.end(); });

const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const tomorrow = () => new Date(Date.now() + 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);

async function setup() {
  const clinic = await newClinic();
  const doctor = await addStaff(clinic.admin, "doctor", outbox);
  const recep = await addStaff(clinic.admin, "receptionist", outbox);
  return { ...clinic, doctor, recep };
}
async function patient(actor: Parameters<typeof registerPatient>[0], name: string, phone?: string) {
  const r = ok(await registerPatient(actor, { name, phone }, { confirmNew: true }));
  if (!("patientId" in r)) throw new Error("dup");
  return r.patientId;
}

describe("clinic settings", () => {
  it("clinic admin updates the profile; receptionist cannot", async () => {
    const { admin, recep } = await setup();
    const input = { name: "Smile Dental Koramangala", address: "12 MG Road", city: "Bengaluru", phone: "080 4000 1234", email: "", languages: ["en", "kn"] as ("en" | "kn")[],
      workingHours: { mon: { open: "09:00", close: "18:00" }, sun: null }, defaultAppointmentMinutes: 20 };
    ok(await updateClinicProfile(admin, input));
    const c = ok(await getClinic(admin));
    expect(c.name).toBe("Smile Dental Koramangala");
    expect(c.languages).toEqual(["en", "kn"]);
    expect(c.settings.defaultAppointmentMinutes).toBe(20);
    expect(c.status).toBe("active");
    expect((await updateClinicProfile(recep, input)).ok).toBe(false);
    const bad = await updateClinicProfile(admin, { ...input, workingHours: { mon: { open: "18:00", close: "09:00" } } });
    expect(bad.ok).toBe(false);
  });

  it("services and FAQs: admin edits, everyone reads, names are unique", async () => {
    const { admin, recep } = await setup();
    ok(await saveService(admin, { name: "Root canal", durationMinutes: 60 }));
    expect((await saveService(admin, { name: "Root canal", durationMinutes: 45 })).ok).toBe(false);
    expect((await saveService(recep, { name: "Cleaning", durationMinutes: 30 })).ok).toBe(false);
    expect(ok(await listServices(recep)).map((s) => s.name)).toEqual(["Root canal"]);
    const faq = ok(await saveFaq(admin, { question: "Do you take walk-ins?", answer: "Yes, 9am to 1pm.", language: "en" }));
    expect(ok(await listFaqs(recep))).toHaveLength(1);
    expect((await deleteFaq(recep, faq)).ok).toBe(false);
    ok(await deleteFaq(admin, faq));
    expect(ok(await listFaqs(admin))).toHaveLength(0);
  });

  it("consent wording starts from defaults in English and Hindi and is versioned", async () => {
    const { admin } = await setup();
    const before = ok(await currentConsentWordings(admin));
    expect(before.map((w) => [w.language, w.version])).toEqual([["en", "default-1"], ["hi", "default-1"]]);
    expect(before[1].wording).toMatch(/क्लिनिक/);
    expect(ok(await saveConsentWording(admin, "en", "My clinic's own wording that patients agree to for calls."))).toBe("clinic-v1");
    expect(ok(await saveConsentWording(admin, "en", "My clinic's second wording that patients agree to for calls."))).toBe("clinic-v2");
    expect(ok(await currentConsentWordings(admin))[0].version).toBe("clinic-v2");
  });
});

describe("staff permissions", () => {
  it("admin changes a receptionist's permissions; it takes effect and is audited", async () => {
    const { admin, recep } = await setup();
    const res = ok(await setStaffCapabilities(admin, recep.userId, ["view_patients", "edit_patient", "view_documents"]));
    expect(res.added).toEqual(["view_documents"]);
    expect(res.removed).toContain("manage_appointments");
    const staff = ok(await listStaff(admin));
    expect(staff.find((s) => s.id === recep.userId)!.capabilities).toEqual(["edit_patient", "view_documents", "view_patients"]);
    expect(staff.every((s) => s.hasPassword)).toBe(true);
    expect((await setStaffCapabilities(recep, admin.userId, [])).ok).toBe(false);
  });

  it("a permission switched off by RedClinic cannot be granted", async () => {
    const { admin, recep, clinicId } = await setup();
    await owner.query("INSERT INTO clinic_features (clinic_id, feature, enabled) VALUES ($1, 'cap:export_data', false)", [clinicId]);
    const r = await setStaffCapabilities(admin, recep.userId, ["view_patients", "export_data"]);
    expect(r.ok).toBe(false);
    expect(ok(await listCapabilities(admin)).find((c) => c.code === "export_data")!.allowed).toBe(false);
  });

  it("another clinic's admin cannot change this clinic's staff", async () => {
    const a = await setup();
    const b = await newClinic();
    expect((await setStaffCapabilities(b.admin, a.recep.userId, ["export_data"])).ok).toBe(false);
  });
});

describe("patients", () => {
  it("registers with a permanent code and warns about duplicates by phone and by name", async () => {
    const { recep } = await setup();
    const first = ok(await registerPatient(recep, { name: "Rahul Verma", phone: "+91 98450 12345", ageYears: 34 }));
    expect("patientId" in first && first.code).toMatch(/^RC-\d+$/);
    const byPhone = ok(await registerPatient(recep, { name: "R Verma", phone: "9845012345" }));
    expect("duplicates" in byPhone && byPhone.duplicates[0].reason).toBe("same phone");
    const byName = ok(await registerPatient(recep, { name: "Rahul Varma", ageYears: 34 }));
    expect("duplicates" in byName && byName.duplicates[0].reason).toBe("similar name");
    const forced = ok(await registerPatient(recep, { name: "Rahul Varma", ageYears: 34 }, { confirmNew: true }));
    expect("patientId" in forced).toBe(true);
  });

  it("validates input in plain language", async () => {
    const { recep } = await setup();
    const r = await registerPatient(recep, { name: "A" });
    expect(r.ok).toBe(false);
    const r2 = await registerPatient(recep, { name: "Asha", phone: "abc" });
    expect(!r2.ok && r2.error).toBe("Enter a valid phone number.");
  });

  it("searches by name, code and phone; phone changes keep the same patient", async () => {
    const { recep } = await setup();
    const id = await patient(recep, "Meena Iyer", "98860 55555");
    const p = ok(await getPatient(recep, id));
    expect(ok(await searchPatients(recep, { q: "meena" })).patients[0].id).toBe(id);
    expect(ok(await searchPatients(recep, { q: p.code.toLowerCase() })).patients[0].id).toBe(id);
    expect(ok(await searchPatients(recep, { q: "55555" })).patients[0].id).toBe(id);
    ok(await updatePatient(recep, id, { name: "Meena Iyer", phone: "90000 11111" }));
    const after = ok(await getPatient(recep, id));
    expect(after.code).toBe(p.code);
    expect(ok(await searchPatients(recep, { q: "11111" })).patients[0].id).toBe(id);
  });

  it("medical history is hidden from the receptionist and visible to the doctor (and the view is audited)", async () => {
    const { recep, doctor, admin } = await setup();
    const id = await patient(recep, "Kiran Rao");
    expect(ok(await getPatient(recep, id)).clinical).toBeNull();
    expect((await updateClinical(recep, id, { allergies: "Penicillin" })).ok).toBe(false);
    ok(await updateClinical(doctor, id, { allergies: "Penicillin", medicalHistory: "Diabetic" }));
    expect(ok(await getPatient(doctor, id)).clinical).toMatchObject({ allergies: "Penicillin", medicalHistory: "Diabetic" });
    const n = await withContext(contextOf(admin), async (c) => (await c.query("SELECT count(*)::int n FROM audit_log WHERE action='patient_history_viewed' AND actor_user_id=$1", [doctor.userId])).rows[0].n);
    expect(n).toBe(1);
  });

  it("consent: recorded with method and wording version; withdrawal flags the admin", async () => {
    const { recep, admin } = await setup();
    const id = await patient(recep, "Fatima Khan");
    expect(ok(await getPatient(recep, id)).consentStatus).toBe("not_recorded");
    ok(await recordConsent(recep, id, { status: "given", method: "in_person", language: "hi" }));
    expect(ok(await getPatient(recep, id)).consentStatus).toBe("given");
    ok(await recordConsent(recep, id, { status: "withdrawn", method: "verbal", note: "Asked on phone" }));
    const h = ok(await consentHistory(recep, id));
    expect(h.map((x) => x.status)).toEqual(["withdrawn", "given"]);
    expect(h[1].wordingVersion).toBe("hi:default-1");
    const att = await withContext(contextOf(admin), async (c) => (await c.query("SELECT kind FROM attention_items WHERE patient_id=$1", [id])).rows);
    expect(att).toEqual([{ kind: "consent_withdrawn" }]);
  });

  it("merge moves appointments and documents, keeps both codes findable, and needs permission", async () => {
    const { recep, admin, doctor } = await setup();
    const keep = await patient(recep, "Sunil Shetty", "9900011111");
    const dup = await patient(recep, "Sunil Shety", "9900011111");
    expect(ok(await duplicatesOf(recep, keep)).map((d) => d.patientId)).toContain(dup);
    ok(await bookAppointment(recep, { patientId: dup, doctorId: doctor.userId, date: tomorrow(), time: "10:00" }));
    ok(await uploadDocument(recep, { patientId: dup, docType: "note", description: "X-ray pending" }));
    const dupCode = ok(await getPatient(recep, dup)).code;

    expect((await mergePatients(recep, keep, dup)).ok).toBe(false);
    ok(await mergePatients(admin, keep, dup));
    const tl = ok(await patientTimeline(admin, keep));
    expect(tl.map((t) => t.kind).sort()).toEqual(["appointment", "document"]);
    expect(ok(await searchPatients(admin, { q: dupCode })).patients[0].id).toBe(keep);
    expect(ok(await searchPatients(admin, { q: "Sunil" })).patients.map((p) => p.id)).toEqual([keep]);
    expect((await mergePatients(admin, keep, dup)).ok).toBe(false); // already merged
  });

  it("CSV import skips likely duplicates and reports bad rows; export is safe for spreadsheets", async () => {
    const { admin } = await setup();
    await patient(admin, "Existing Person", "9811122233");
    const csv = 'Name,Mobile Number,DOB,Gender\r\n"Anita Desai",98111 99999,05/03/1990,F\r\nExisting Person,9811122233,,\r\nBad Phone,xx,,\r\n"=HYPERLINK(""x"")",,,\r\n';
    const rep = ok(await importPatientsCsv(admin, csv));
    expect(rep.created).toBe(2);
    expect(rep.skippedDuplicates.map((s) => s.row)).toEqual([3]);
    expect(rep.errors).toEqual([{ row: 4, error: "Enter a valid phone number." }]);
    const anita = ok(await searchPatients(admin, { q: "Anita" })).patients[0];
    expect(ok(await getPatient(admin, anita.id)).dateOfBirth).toBe("1990-03-05");
    const out = parseCsv(ok(await exportPatientsCsv(admin)).replace(/^﻿/, ""));
    expect(out[0][0]).toBe("patient_id");
    expect(out.some((r) => r[1] === "'=HYPERLINK(\"x\")")).toBe(true);
  });

  it("import and export need their permissions", async () => {
    const { recep } = await setup();
    expect((await importPatientsCsv(recep, "name\nA B\n")).ok).toBe(false);
    expect((await exportPatientsCsv(recep)).ok).toBe(false);
  });

  it("another clinic cannot see or edit the patient", async () => {
    const a = await setup();
    const b = await newClinic();
    const id = await patient(a.recep, "Private Person");
    expect((await getPatient(b.admin, id)).ok).toBe(false);
    expect((await updatePatient(b.admin, id, { name: "Hacked" })).ok).toBe(false);
    expect(ok(await searchPatients(b.admin, { q: "Private" })).total).toBe(0);
  });
});

describe("appointments", () => {
  it("books in clinic time, uses the service length, and lists by day", async () => {
    const { recep, doctor, admin } = await setup();
    const svc = ok(await saveService(admin, { name: "Cleaning", durationMinutes: 45 }));
    const id = await patient(recep, "Leela Nair");
    const day = tomorrow();
    const a = ok(await bookAppointment(recep, { patientId: id, doctorId: doctor.userId, serviceId: svc, date: day, time: "09:00" }));
    const appt = ok(await getAppointment(recep, a));
    expect(appt.localTime).toBe("09:00");
    expect(appt.startsAt.toISOString()).toBe(`${day}T03:30:00.000Z`); // 09:00 IST
    expect(appt.durationMinutes).toBe(45);
    expect(ok(await listAppointments(recep, { from: day, to: day })).map((x) => x.id)).toEqual([a]);
  });

  it("refuses double booking with a clear message, but another doctor is fine", async () => {
    const { recep, doctor, admin } = await setup();
    const doctor2 = await addStaff(admin, "doctor", outbox);
    const p1 = await patient(recep, "Patient One");
    const p2 = await patient(recep, "Patient Two");
    const day = tomorrow();
    ok(await bookAppointment(recep, { patientId: p1, doctorId: doctor.userId, date: day, time: "11:00", durationMinutes: 30 }));
    const clash = await bookAppointment(recep, { patientId: p2, doctorId: doctor.userId, date: day, time: "11:15" });
    expect(!clash.ok && clash.error).toMatch(/already has an appointment/);
    ok(await bookAppointment(recep, { patientId: p2, doctorId: doctor2.userId, date: day, time: "11:15" }));
  });

  it("reschedule keeps history; status changes follow the rules", async () => {
    const { recep, doctor } = await setup();
    const p = await patient(recep, "Arjun Das");
    const day = tomorrow();
    const a = ok(await bookAppointment(recep, { patientId: p, doctorId: doctor.userId, date: day, time: "14:00" }));
    const b = ok(await rescheduleAppointment(recep, a, { date: day, time: "14:15" })); // overlaps its own old slot: allowed
    expect(ok(await getAppointment(recep, a))).toMatchObject({ status: "cancelled", cancelReason: "Rescheduled" });
    ok(await setAppointmentStatus(recep, b, "confirmed"));
    expect((await setAppointmentStatus(recep, b, "completed")).ok).toBe(false); // tomorrow: hasn't happened
    ok(await setAppointmentStatus(recep, b, "cancelled", "Patient travelling"));
    expect((await setAppointmentStatus(recep, b, "confirmed")).ok).toBe(false);
    expect(ok(await listAppointments(recep, { from: day, to: day }))).toHaveLength(0);
    expect(ok(await listAppointments(recep, { from: day, to: day, includeCancelled: true }))).toHaveLength(2);
  });

  it("walk-in is booked now and can be completed", async () => {
    const { recep, doctor } = await setup();
    const p = await patient(recep, "Walk In");
    const a = ok(await bookWalkIn(recep, { patientId: p, doctorId: doctor.userId }));
    const appt = ok(await getAppointment(recep, a));
    expect(appt.bookedVia).toBe("walk_in");
    expect(appt.localDate).toBe(ok(await clinicToday(recep)));
    ok(await setAppointmentStatus(recep, a, "completed"));
    expect(ok(await getPatient(recep, p)).lastVisit).not.toBeNull();
  });

  it("past times are refused; staff without permission cannot book; other clinic's doctor is refused", async () => {
    const { recep, doctor, admin } = await setup();
    const p = await patient(recep, "Late Comer");
    expect((await bookAppointment(recep, { patientId: p, doctorId: doctor.userId, date: "2020-01-01", time: "10:00" })).ok).toBe(false);
    const manager = await addStaff(admin, "clinic_manager", outbox);
    ok(await setStaffCapabilities(admin, manager.userId, ["view_patients"]));
    expect((await bookAppointment(manager, { patientId: p, doctorId: doctor.userId, date: tomorrow(), time: "10:00" })).ok).toBe(false);
    const other = await setup();
    expect((await bookAppointment(recep, { patientId: p, doctorId: other.doctor.userId, date: tomorrow(), time: "10:00" })).ok).toBe(false);
  });
});
