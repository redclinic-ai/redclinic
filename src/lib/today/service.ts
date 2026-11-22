// The Today screen: what is happening today, what needs attention, what RedClinic did, and setup steps for new clinics.
import type { SignedInUser } from "../auth/service";
import { act, can } from "../authz";

export interface SetupStep { key: string; label: string; done: boolean; href: string }

export async function getToday(actor: SignedInUser) {
  return act(actor, async (c) => {
    const tz = (await c.query("SELECT timezone, to_char(now() AT TIME ZONE timezone,'YYYY-MM-DD') AS d FROM clinics WHERE id = rc_clinic_id()")).rows[0];
    const canAppts = (await can(c, "manage_appointments")) || (await can(c, "view_patients"));
    const appts = canAppts ? (await c.query(
      `SELECT a.id, a.status, a.starts_at, to_char(a.starts_at AT TIME ZONE $1,'HH24:MI') AS t, p.name, p.id AS patient_id, d.display_name AS doctor, s.name AS service
       FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users d ON d.id = a.doctor_id LEFT JOIN clinic_services s ON s.id = a.service_id
       WHERE a.starts_at >= ($2::date::timestamp AT TIME ZONE $1) AND a.starts_at < (($2::date + 1)::timestamp AT TIME ZONE $1) AND a.status <> 'cancelled'
         ${actor.role === "doctor" ? "AND a.doctor_id = $3" : ""}
       ORDER BY a.starts_at`, actor.role === "doctor" ? [tz.timezone, tz.d, actor.userId] : [tz.timezone, tz.d],
    )).rows : [];
    let attention: { id: string; kind: string; reason: string; urgency: number; patient: string | null }[] = [];
    let attentionCount = 0;
    if (await can(c, "manage_attention")) {
      await c.query("SELECT rc_refresh_attention()");
      const r = await c.query(
        `SELECT i.id, i.kind, i.reason, i.urgency, p.name AS patient FROM attention_items i LEFT JOIN patients p ON p.id = i.patient_id
         WHERE i.status = 'open' AND NOT i.is_simulated ORDER BY i.urgency, i.created_at LIMIT 5`);
      attention = r.rows;
      attentionCount = (await c.query("SELECT count(*)::int n FROM attention_items WHERE status='open' AND NOT is_simulated")).rows[0].n;
    }
    const done = (await c.query(
      `SELECT count(*) FILTER (WHERE handled_by_nepa AND status='completed')::int AS calls_handled,
              count(*) FILTER (WHERE direction='outbound' AND purpose IN ('confirmation','reminder'))::int AS reminders,
              count(*) FILTER (WHERE direction='inbound')::int AS calls_in
       FROM calls WHERE NOT is_simulated AND started_at >= ($1::date::timestamp AT TIME ZONE $2)`, [tz.d, tz.timezone])).rows[0];
    const bookedByNepa = (await c.query(
      "SELECT count(*)::int n FROM appointments WHERE booked_via='nepa' AND created_at >= ($1::date::timestamp AT TIME ZONE $2)", [tz.d, tz.timezone])).rows[0].n;

    let setup: SetupStep[] = [];
    if (await can(c, "manage_settings")) {
      const s = (await c.query(
        `SELECT (SELECT count(*) FROM users WHERE role='doctor' AND status='active') AS doctors,
                (SELECT count(*) FROM users WHERE role IN ('receptionist','clinic_manager')) AS desk,
                (SELECT count(*) FROM clinic_services) AS services,
                (SELECT count(*) FROM clinic_faqs) AS faqs,
                (SELECT working_hours <> '{}'::jsonb FROM clinics WHERE id = rc_clinic_id()) AS hours,
                (SELECT count(*) FROM patients) AS patients,
                (SELECT count(*) FROM clinic_phone_numbers WHERE status = 'verified') AS phone`)).rows[0];
      setup = [
        { key: "hours", label: "Set your opening hours", done: s.hours, href: "/settings" },
        { key: "doctors", label: "Add your doctors", done: Number(s.doctors) > 0, href: "/settings/staff" },
        { key: "desk", label: "Add your receptionist", done: Number(s.desk) > 0, href: "/settings/staff" },
        { key: "services", label: "List your treatments", done: Number(s.services) > 0, href: "/settings/services" },
        { key: "faqs", label: "Add common questions for the AI receptionist", done: Number(s.faqs) > 0, href: "/settings/faqs" },
        { key: "patients", label: "Import or add your patients", done: Number(s.patients) > 0, href: "/patients/import" },
        { key: "phone", label: "Connect your clinic phone number", done: Number(s.phone) > 0, href: "/settings/phone" },
      ];
    }
    return {
      date: tz.d as string,
      appointments: appts.map((a) => ({ id: a.id, status: a.status, time: a.t, startsAt: a.starts_at, patient: a.name, patientId: a.patient_id, doctor: a.doctor, service: a.service })),
      attention, attentionCount, setup,
      completed: { callsHandled: done.calls_handled as number, reminders: done.reminders as number, callsIn: done.calls_in as number, bookedByNepa: bookedByNepa as number },
    };
  });
}
