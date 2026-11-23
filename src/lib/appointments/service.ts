// Appointments: book, reschedule, cancel, confirm, complete, no-show, walk-ins; day and range lists.
// Times are entered and shown in the clinic's timezone. Double booking of a doctor is refused by the database.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";

export const STATUSES = ["scheduled", "confirmed", "completed", "no_show", "cancelled"] as const;
export type AppointmentStatus = (typeof STATUSES)[number];

export interface Appointment {
  id: string; patientId: string; patientName: string; patientCode: string; patientPhone: string | null;
  doctorId: string | null; doctorName: string | null; serviceId: string | null; serviceName: string | null;
  startsAt: Date; endsAt: Date; localDate: string; localTime: string; durationMinutes: number;
  status: AppointmentStatus; type: "in_clinic" | "online"; reason: string | null; bookedVia: string; cancelReason: string | null;
}

const SELECT = `
  SELECT a.*, p.name AS patient_name, p.patient_code, p.phone AS patient_phone, d.display_name AS doctor_name, s.name AS service_name,
         to_char(a.starts_at AT TIME ZONE cl.timezone, 'YYYY-MM-DD') AS local_date,
         to_char(a.starts_at AT TIME ZONE cl.timezone, 'HH24:MI') AS local_time
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN clinics cl ON cl.id = a.clinic_id
  LEFT JOIN users d ON d.id = a.doctor_id
  LEFT JOIN clinic_services s ON s.id = a.service_id`;

function toAppt(x: Record<string, any>): Appointment {
  return {
    id: x.id, patientId: x.patient_id, patientName: x.patient_name, patientCode: x.patient_code, patientPhone: x.patient_phone,
    doctorId: x.doctor_id, doctorName: x.doctor_name, serviceId: x.service_id, serviceName: x.service_name,
    startsAt: x.starts_at, endsAt: x.ends_at, localDate: x.local_date, localTime: x.local_time,
    durationMinutes: Math.round((x.ends_at.getTime() - x.starts_at.getTime()) / 60000),
    status: x.status, type: x.appointment_type, reason: x.reason, bookedVia: x.booked_via, cancelReason: x.cancel_reason,
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Choose a time.");

const bookSchema = z.object({
  patientId: z.string().uuid("Choose a patient."),
  doctorId: z.string().uuid("Choose a doctor."),
  serviceId: z.string().optional().transform((v) => v || null),
  date, time,
  durationMinutes: z.union([z.literal(""), z.coerce.number().int().min(5).max(480)]).optional().transform((v) => (v === "" || v === undefined ? null : v)),
  type: z.enum(["in_clinic", "online"]).default("in_clinic"),
  reason: z.string().trim().max(500).optional().transform((v) => v || null),
});
export type BookInput = z.input<typeof bookSchema>;

async function resolveDuration(c: PoolClient, serviceId: string | null, explicit: number | null): Promise<number> {
  if (explicit) return explicit;
  if (serviceId) {
    const s = (await c.query("SELECT duration_minutes FROM clinic_services WHERE id = $1", [serviceId])).rows[0];
    if (!s) throw new UserError("Choose a service from the list.", "serviceId");
    return s.duration_minutes;
  }
  const cl = (await c.query("SELECT settings FROM clinics WHERE id = rc_clinic_id()")).rows[0];
  return cl?.settings?.defaultAppointmentMinutes ?? 30;
}

async function checkPeople(c: PoolClient, patientId: string, doctorId: string) {
  const p = (await c.query("SELECT 1 FROM patients WHERE id = $1 AND merged_into IS NULL", [patientId])).rowCount;
  if (!p) throw new UserError("Patient not found.", "patientId");
  const d = (await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'doctor' AND status = 'active'", [doctorId])).rowCount;
  if (!d) throw new UserError("Choose a doctor from the list.", "doctorId");
}

/** Local clinic date + time → timestamptz, done by the database with the clinic's timezone. */
const LOCAL_TS = `(($1::date + $2::time) AT TIME ZONE (SELECT timezone FROM clinics WHERE id = rc_clinic_id()))`;

export async function bookAppointment(actor: SignedInUser, input: BookInput, via: "staff" | "walk_in" | "nepa" = "staff") {
  return act(actor, async (c) => {
    await requireCap(c, "manage_appointments", "You don't have permission to book appointments.");
    const p = bookSchema.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    const d = p.data;
    await checkPeople(c, d.patientId, d.doctorId);
    const minutes = await resolveDuration(c, d.serviceId, d.durationMinutes);
    const starts = (await c.query(`SELECT ${LOCAL_TS} AS t`, [d.date, d.time])).rows[0].t as Date;
    if (via === "staff" && starts.getTime() < Date.now() - 15 * 60_000) throw new UserError("That time has already passed. Choose a later time.", "time");
    const r = await c.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, appointment_type, reason, booked_via, created_by)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6::int),'scheduled',$7,$8,$9,$10) RETURNING id`,
      [actor.clinicId, d.patientId, d.doctorId, d.serviceId, starts, minutes, d.type, d.reason, via, actor.userId],
    );
    await audit(c, actor, "appointment_booked", "appointment", r.rows[0].id, { patient_id: d.patientId, via });
    return r.rows[0].id as string;
  });
}

/** Walk-in: the patient is here now. Books from the current time (rounded down to 5 minutes). */
export async function bookWalkIn(actor: SignedInUser, input: { patientId: string; doctorId: string; serviceId?: string; reason?: string }) {
  const now = await act(actor, async (c) =>
    (await c.query(`SELECT to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS d,
                           to_char(date_trunc('hour', now() AT TIME ZONE timezone) + floor(extract(minute from now() AT TIME ZONE timezone)/5)*interval '5 min','HH24:MI') AS t
                    FROM clinics WHERE id = rc_clinic_id()`)).rows[0]);
  if (!now.ok) return now;
  return bookAppointment(actor, { ...input, date: now.value.d, time: now.value.t }, "walk_in");
}

/**
 * Moves an appointment. The old one is kept as cancelled ("rescheduled") and a new one is created, so the
 * history shows both. Fails without changes if the new time is taken.
 */
export async function rescheduleAppointment(actor: SignedInUser, id: string, input: { date: string; time: string; doctorId?: string; durationMinutes?: number }) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_appointments");
    const old = (await c.query("SELECT * FROM appointments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!old) throw new UserError("Appointment not found.");
    if (!["scheduled", "confirmed"].includes(old.status)) throw new UserError("Only upcoming appointments can be moved.");
    const dt = z.object({ date, time }).safeParse(input);
    if (!dt.success) throw firstIssue(dt.error);
    const doctorId = input.doctorId || old.doctor_id;
    await checkPeople(c, old.patient_id, doctorId);
    const minutes = input.durationMinutes || Math.round((old.ends_at - old.starts_at) / 60000);
    const starts = (await c.query(`SELECT ${LOCAL_TS} AS t`, [dt.data.date, dt.data.time])).rows[0].t as Date;
    if (starts.getTime() < Date.now() - 15 * 60_000) throw new UserError("That time has already passed. Choose a later time.", "time");
    await c.query("UPDATE appointments SET status='cancelled', cancel_reason='Rescheduled', updated_at=now() WHERE id=$1", [id]);
    const r = await c.query(
      `INSERT INTO appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, appointment_type, reason, booked_via, created_by, rescheduled_from)
       VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + make_interval(mins => $6::int),'scheduled',$7,$8,$9,$10,$11) RETURNING id`,
      [old.clinic_id, old.patient_id, doctorId, old.service_id, starts, minutes, old.appointment_type, old.reason, old.booked_via, actor.userId, id],
    );
    await audit(c, actor, "appointment_rescheduled", "appointment", r.rows[0].id, { from: id });
    return r.rows[0].id as string;
  });
}

const ALLOWED: Record<string, AppointmentStatus[]> = {
  scheduled: ["confirmed", "completed", "no_show", "cancelled"],
  confirmed: ["scheduled", "completed", "no_show", "cancelled"],
  no_show: ["completed"],          // patient turned up late after being marked no-show
  completed: [],
  cancelled: [],
};

export async function setAppointmentStatus(actor: SignedInUser, id: string, status: AppointmentStatus, cancelReason?: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_appointments");
    if (!STATUSES.includes(status)) throw new UserError("Unknown status.");
    const a = (await c.query("SELECT status, starts_at FROM appointments WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!a) throw new UserError("Appointment not found.");
    if (!ALLOWED[a.status].includes(status)) throw new UserError(`A ${a.status.replace("_", "-")} appointment can't be marked ${status.replace("_", "-")}.`);
    if ((status === "completed" || status === "no_show") && a.starts_at.getTime() > Date.now() + 60 * 60_000) {
      throw new UserError("This appointment hasn't happened yet.");
    }
    await c.query("UPDATE appointments SET status=$2, cancel_reason=$3, updated_at=now() WHERE id=$1",
      [id, status, status === "cancelled" ? (cancelReason?.trim().slice(0, 300) || "Cancelled by clinic") : null]);
    await audit(c, actor, `appointment_${status}`, "appointment", id, { from: a.status });
    return null;
  });
}

export async function getAppointment(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    if (!z.string().uuid().safeParse(id).success) throw new UserError("Appointment not found.");
    const r = await c.query(`${SELECT} WHERE a.id = $1`, [id]);
    if (!r.rowCount) throw new UserError("Appointment not found.");
    return toAppt(r.rows[0]);
  });
}

/** Appointments between two local dates (inclusive), optionally for one doctor. Cancelled ones are left out unless asked. */
export async function listAppointments(actor: SignedInUser, f: { from: string; to: string; doctorId?: string; includeCancelled?: boolean }) {
  return act(actor, async (c) => {
    const dd = z.object({ from: date, to: date }).safeParse(f);
    if (!dd.success) throw firstIssue(dd.error);
    const args: unknown[] = [f.from, f.to];
    let extra = "";
    if (f.doctorId) { args.push(f.doctorId); extra += ` AND a.doctor_id = $${args.length}`; }
    if (!f.includeCancelled) extra += " AND a.status <> 'cancelled'";
    const r = await c.query(
      `${SELECT} WHERE a.clinic_id = rc_clinic_id()
         AND a.starts_at >= ($1::date::timestamp AT TIME ZONE (SELECT timezone FROM clinics WHERE id = rc_clinic_id()))
         AND a.starts_at < (($2::date + 1)::timestamp AT TIME ZONE (SELECT timezone FROM clinics WHERE id = rc_clinic_id())) ${extra}
       ORDER BY a.starts_at, d.display_name`,
      args,
    );
    return r.rows.map(toAppt);
  });
}

export async function patientAppointments(actor: SignedInUser, patientId: string) {
  return act(actor, async (c) => (await c.query(`${SELECT} WHERE a.patient_id = $1 ORDER BY a.starts_at DESC LIMIT 100`, [patientId])).rows.map(toAppt));
}

/** Today's date in the clinic's timezone (YYYY-MM-DD). */
export async function clinicToday(actor: SignedInUser) {
  return act(actor, async (c) => (await c.query("SELECT to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS d FROM clinics WHERE id = rc_clinic_id()")).rows[0]?.d as string);
}
