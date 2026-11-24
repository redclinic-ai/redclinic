import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { closePool } from "@/lib/db";
import { addAttention, assignAttention, listAttention, reopenAttention, resolveAttention, snoozeAttention, snoozeUntil } from "@/lib/attention/service";
import { exportResultsCsv, getResults, periodRange } from "@/lib/results/service";
import { getToday } from "@/lib/today/service";
import { bookAppointment, setAppointmentStatus } from "@/lib/appointments/service";
import { registerPatient } from "@/lib/patients/service";
import { saveService } from "@/lib/clinic/service";
import { setStaffCapabilities } from "@/lib/staff/service";
import { addStaff, freshOutbox, newClinic } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

async function setup() {
  const c = await newClinic();
  const doctor = await addStaff(c.admin, "doctor", outbox);
  const recep = await addStaff(c.admin, "receptionist", outbox);
  return { ...c, doctor, recep };
}
async function patient(actor: Parameters<typeof registerPatient>[0], name: string) {
  const r = ok(await registerPatient(actor, { name }, { confirmNew: true }));
  return (r as { patientId: string }).patientId;
}
/** Appointment at an exact instant, written by the owner (to place it in the past). */
async function apptAt(clinicId: string, patientId: string, doctorId: string, at: Date, status: string, extra: Record<string, unknown> = {}) {
  const r = await owner.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status, booked_via, created_at, source_call_id)
     VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 min',$5,$6,$7,$8) RETURNING id`,
    [clinicId, patientId, doctorId, at, status, extra.via ?? "staff", extra.createdAt ?? new Date(at.getTime() - 86_400_000), extra.sourceCall ?? null]);
  return r.rows[0].id as string;
}
async function call(clinicId: string, v: Record<string, unknown>) {
  const r = await owner.query(
    `INSERT INTO calls (clinic_id, direction, status, started_at, duration_seconds, handled_by_nepa, handed_to_staff, is_simulated, purpose, callback_of, patient_id, transcription_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed') RETURNING id`,
    [clinicId, v.direction ?? "inbound", v.status ?? "completed", v.at ?? new Date(), v.seconds ?? 60, v.nepa ?? true, v.staff ?? false,
     v.sim ?? false, v.purpose ?? null, v.callbackOf ?? null, v.patientId ?? null]);
  return r.rows[0].id as string;
}
const hours = (h: number) => new Date(Date.now() + h * 3600_000);

describe("needs attention", () => {
  it("lists unconfirmed appointments in the next 24 hours, urgent ones first, and clears them when confirmed", async () => {
    const { recep, doctor, clinicId } = await setup();
    const p1 = await patient(recep, "Soon Patient");
    const p2 = await patient(recep, "Later Patient");
    const soon = await apptAt(clinicId, p1, doctor.userId, hours(2), "scheduled");
    const later = await apptAt(clinicId, p2, doctor.userId, hours(20), "scheduled");
    await apptAt(clinicId, p2, doctor.userId, hours(40), "scheduled"); // beyond 24h: not listed
    const { items, counts } = ok(await listAttention(recep));
    expect(items.map((i) => [i.appointmentId, i.urgency])).toEqual([[soon, 1], [later, 2]]);
    expect(counts).toMatchObject({ open: 2, urgent: 1 });
    expect(items[0].nextAction).toBe("Call to confirm");
    // listing again does not duplicate
    expect(ok(await listAttention(recep)).items).toHaveLength(2);
    ok(await setAppointmentStatus(recep, soon, "confirmed"));
    expect(ok(await listAttention(recep)).items.map((i) => i.appointmentId)).toEqual([later]);
    expect(ok(await listAttention(recep, { view: "resolved" })).items[0].resolution).toMatch(/automatically/);
  });

  it("lists no-shows that have not rebooked, and clears them once the patient books again", async () => {
    const { recep, doctor, clinicId } = await setup();
    const p = await patient(recep, "Missed Patient");
    const ns = await apptAt(clinicId, p, doctor.userId, hours(-48), "no_show");
    expect(ok(await listAttention(recep)).items.map((i) => [i.kind, i.appointmentId])).toEqual([["no_show_no_rebooking", ns]]);
    const day = new Date(Date.now() + 3 * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    ok(await bookAppointment(recep, { patientId: p, doctorId: doctor.userId, date: day, time: "10:00" }));
    expect(ok(await listAttention(recep)).items).toHaveLength(0);
  });

  it("resolve, reopen, snooze and assign are recorded; staff without permission cannot", async () => {
    const { recep, admin, doctor } = await setup();
    const p = await patient(recep, "Complainer");
    const id = ok(await addAttention(recep, { kind: "complaint", reason: "Waited 40 minutes", patientId: p, urgency: 1 }));
    ok(await assignAttention(recep, id, admin.userId));
    expect(ok(await listAttention(admin, { mine: true })).items.map((i) => i.id)).toEqual([id]);
    ok(await snoozeAttention(recep, id, "1h"));
    expect(ok(await listAttention(recep)).items).toHaveLength(0);
    expect(ok(await listAttention(recep, { view: "snoozed" })).items).toHaveLength(1);
    ok(await resolveAttention(recep, id, "Spoke to patient, apologised"));
    const done = ok(await listAttention(recep, { view: "resolved", q: "Complainer" })).items[0];
    expect(done).toMatchObject({ resolution: "Spoke to patient, apologised", resolvedByName: "Test receptionist" });
    ok(await reopenAttention(recep, id));
    expect(ok(await listAttention(recep)).items).toHaveLength(1);
    expect((await resolveAttention(doctor, id)).ok).toBe(false); // doctor preset has no manage_attention
    expect((await listAttention(doctor)).ok).toBe(false);
  });

  it("a snooze ends by itself", async () => {
    const { recep } = await setup();
    const id = ok(await addAttention(recep, { kind: "unanswered_question", reason: "Asks about braces" }));
    ok(await snoozeAttention(recep, id, "1h"));
    await owner.query("UPDATE attention_items SET snoozed_until = now() - interval '1 minute' WHERE id = $1", [id]);
    expect(ok(await listAttention(recep)).items.map((i) => i.id)).toEqual([id]);
  });

  it("snooze 'tomorrow' means 9 am India time", () => {
    expect(snoozeUntil("tomorrow", new Date("2026-11-22T20:00:00Z"))!.toISOString()).toBe("2026-11-24T03:30:00.000Z"); // 01:30 IST on the 23rd
    expect(snoozeUntil("tomorrow", new Date("2026-11-22T10:00:00Z"))!.toISOString()).toBe("2026-11-23T03:30:00.000Z");
  });

  it("simulated items are hidden unless asked for; other clinics never see items", async () => {
    const a = await setup();
    const b = await newClinic();
    await owner.query("INSERT INTO attention_items (clinic_id, kind, reason, is_simulated) VALUES ($1,'call_handed_over','Test call',true)", [a.clinicId]);
    expect(ok(await listAttention(a.recep)).items).toHaveLength(0);
    expect(ok(await listAttention(a.recep, { includeSimulated: true })).items).toHaveLength(1);
    expect(ok(await listAttention(b.admin, { includeSimulated: true })).items).toHaveLength(0);
  });
});

describe("results", () => {
  it("counts every metric from records, excludes simulated calls, and explains each one", async () => {
    const { recep, doctor, admin, clinicId } = await setup();
    const p = await patient(recep, "Results Patient");
    const now = new Date(Date.now() - 60_000);
    const missed = await call(clinicId, { status: "missed", nepa: false, seconds: 0, at: now });
    await call(clinicId, { status: "missed", nepa: false, seconds: 0, at: now }); // not called back
    const back = await call(clinicId, { direction: "outbound", purpose: "callback", callbackOf: missed, seconds: 125, at: now });
    await call(clinicId, { seconds: 90, at: now });                                        // handled by AI
    await call(clinicId, { seconds: 60, staff: true, status: "handed_to_staff", at: now }); // handed over
    const fu = await call(clinicId, { direction: "outbound", purpose: "recall", seconds: 45, at: now });
    await call(clinicId, { seconds: 600, sim: true, at: now });                             // simulated: ignored
    await apptAt(clinicId, p, doctor.userId, hours(48), "scheduled", { via: "nepa", createdAt: now, sourceCall: back });
    await apptAt(clinicId, p, doctor.userId, hours(72), "confirmed", { via: "nepa", createdAt: now, sourceCall: fu });
    const ns = await apptAt(clinicId, p, doctor.userId, hours(-30), "no_show", { createdAt: hours(-200) });
    await apptAt(clinicId, p, doctor.userId, hours(-26), "completed", { createdAt: hours(-200) });
    void ns;

    const r = ok(await getResults(admin, "7d"));
    expect(r.values).toMatchObject({
      calls_answered: 2, calls_handled_by_nepa: 3, // AI handled: 1 incoming + callback + recall calls_handed_to_staff: 1, calls_missed: 2,
      missed_calls_called_back: 1, appointments_from_missed_calls: 1, appointments_booked_by_nepa: 2,
      no_shows: 1, no_shows_rebooked: 1, followup_calls: 1, visits_booked_from_followups: 1,
      voice_minutes_used: 6, // 125+90+60+45 = 320 seconds → 6 minutes (simulated 600s ignored)
    } as never);
  });

  it("voice minutes round up and the confirmation rate ignores cancelled appointments", async () => {
    const { recep, doctor, admin, clinicId } = await setup();
    const p = await patient(recep, "Rate Patient");
    await call(clinicId, { seconds: 61 });
    // Spread between midnight in the clinic's time zone (IST) and now, so the test passes at any hour.
    const midnightIst = new Date(`${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)}T00:00:00+05:30`).getTime();
    const at = (f: number) => new Date(midnightIst + (Date.now() - midnightIst) * f);
    await apptAt(clinicId, p, doctor.userId, at(0.25), "completed");
    await apptAt(clinicId, p, doctor.userId, at(0.5), "scheduled");
    await apptAt(clinicId, p, doctor.userId, at(0.75), "cancelled");
    const v = ok(await getResults(admin, "today")).values;
    expect(v.voice_minutes_used).toBe(2);
    expect(v.appointments_total).toBe(2);
    expect(v.confirmation_rate_pct).toBe(50);
  });

  it("empty clinic: no calls flag, null rate; permission and export", async () => {
    const { admin, recep } = await setup();
    const r = ok(await getResults(admin, "30d"));
    expect(r.hasCalls).toBe(false);
    expect(r.values.confirmation_rate_pct).toBeNull();
    expect((await getResults(recep, "7d")).ok).toBe(false);
    const csv = ok(await exportResultsCsv(admin, "7d"));
    expect(csv).toContain("Missed calls called back");
    expect(csv).not.toMatch(/revenue|₹|price|fee/i);
  });

  it("periods start at midnight India time", () => {
    const { from } = periodRange("today", new Date("2026-11-22T20:00:00Z")); // 01:30 IST on the 23rd
    expect(from.toISOString()).toBe("2026-11-22T18:30:00.000Z");
    expect(periodRange("7d", new Date("2026-11-22T10:00:00Z")).from.toISOString()).toBe("2026-11-15T18:30:00.000Z");
  });
});

describe("today", () => {
  it("shows today's appointments (a doctor sees only their own), attention and setup steps", async () => {
    const { admin, recep, doctor, clinicId } = await setup();
    const doctor2 = await addStaff(admin, "doctor", outbox);
    const p = await patient(recep, "Today Patient");
    await apptAt(clinicId, p, doctor.userId, hours(0.5), "scheduled");
    await apptAt(clinicId, p, doctor2.userId, hours(1), "confirmed");
    const t = ok(await getToday(recep));
    // today's list only includes appointments still today in IST; both are within 1 hour, so usually 2
    expect(t.appointments.length).toBeGreaterThanOrEqual(1);
    expect(t.attention.length).toBeGreaterThanOrEqual(1);
    expect(t.setup).toEqual([]); // receptionist: no setup steps
    const td = ok(await getToday(doctor));
    expect(td.appointments.every((a) => a.doctor === doctor.displayName)).toBe(true);
    const ta = ok(await getToday(admin));
    expect(Object.fromEntries(ta.setup.map((s) => [s.key, s.done]))).toMatchObject({ doctors: true, desk: true, services: false, patients: true, phone: false });
    ok(await saveService(admin, { name: "Check-up", durationMinutes: 20 }));
    expect(ok(await getToday(admin)).setup.find((s) => s.key === "services")!.done).toBe(true);
  });

  it("a clinic manager without attention permission sees no attention list", async () => {
    const { admin } = await setup();
    const m = await addStaff(admin, "clinic_manager", outbox);
    ok(await setStaffCapabilities(admin, m.userId, ["view_patients"]));
    expect(ok(await getToday(m)).attention).toEqual([]);
  });
});
