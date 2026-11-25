// Results dashboard: counts from real records only, each with a plain explanation. No money anywhere (D5).
import type { SignedInUser } from "../auth/service";
import { act, audit, requireCap } from "../authz";
import { toCsv } from "../patients/csv";

export type Period = "today" | "7d" | "30d";

export const METRICS: { key: string; label: string; how: string; group: string }[] = [
  { group: "Calls", key: "calls_answered", label: "Calls answered", how: "Incoming calls that were picked up (by the AI receptionist or staff)." },
  { group: "Calls", key: "calls_handled_by_nepa", label: "Handled by AI without staff", how: "Incoming and outgoing calls the AI receptionist finished on its own, without handing over to staff." },
  { group: "Calls", key: "calls_missed", label: "Missed calls", how: "Incoming calls nobody answered." },
  { group: "Calls", key: "missed_calls_called_back", label: "Missed calls called back", how: "Missed calls in this period that have a return call linked to them." },
  { group: "Calls", key: "appointments_from_missed_calls", label: "Booked from missed calls", how: "Appointments booked during a return call to a missed call." },
  { group: "Appointments", key: "appointments_booked_by_nepa", label: "Booked by AI receptionist", how: "Appointments created in this period by the AI receptionist." },
  { group: "Appointments", key: "appointments_total", label: "Appointments", how: "Appointments scheduled in this period, not counting cancelled ones." },
  { group: "Appointments", key: "confirmation_rate_pct", label: "Confirmation rate", how: "Confirmed or done appointments ÷ all non-cancelled appointments in this period." },
  { group: "Appointments", key: "no_shows", label: "No-shows", how: "Appointments in this period marked as “didn't come”." },
  { group: "Appointments", key: "no_shows_rebooked", label: "No-shows rebooked", how: "Of those no-shows, patients who booked again afterwards." },
  { group: "Follow-ups", key: "followup_calls", label: "Recall and follow-up calls", how: "Outgoing calls made for recalls, follow-ups and no-show follow-ups." },
  { group: "Follow-ups", key: "visits_booked_from_followups", label: "Visits booked from follow-ups", how: "Appointments booked during one of those calls." },
  { group: "WhatsApp", key: "whatsapp_sent", label: "WhatsApp messages sent", how: "Messages that reached WhatsApp (sent, delivered or read)." },
  { group: "WhatsApp", key: "whatsapp_replies", label: "Patient replies", how: "WhatsApp messages received from patients." },
  { group: "WhatsApp", key: "confirmed_on_whatsapp", label: "Confirmed on WhatsApp", how: "Appointments confirmed by a patient replying 1 to a confirmation message." },
  { group: "Leads and reviews", key: "leads_received", label: "Leads received", how: "Enquiries from lead ads or added by staff in this period." },
  { group: "Leads and reviews", key: "leads_booked", label: "Leads that booked", how: "Of those leads, people who booked an appointment afterwards (not cancelled)." },
  { group: "Leads and reviews", key: "review_requests_sent", label: "Review requests sent", how: "WhatsApp review requests that reached the patient." },
  { group: "Leads and reviews", key: "review_links_opened", label: "Review links opened", how: "Review requests whose link was opened. RedClinic cannot see whether a review was posted." },
  { group: "Usage", key: "voice_minutes_used", label: "Voice minutes used", how: "Total length of all calls in this period, rounded up to whole minutes." },
  { group: "Usage", key: "new_patients", label: "New patients", how: "Patients registered in this period (merged duplicates not counted)." },
];

export function periodRange(p: Period, now = new Date()): { from: Date; to: Date; label: string } {
  // periods follow India time (clinic days start at midnight IST)
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  ist.setUTCHours(0, 0, 0, 0);
  const startToday = new Date(ist.getTime() - 5.5 * 3600_000);
  const days = p === "today" ? 0 : p === "7d" ? 6 : 29;
  return { from: new Date(startToday.getTime() - days * 86_400_000), to: new Date(now.getTime() + 1), label: p === "today" ? "Today" : p === "7d" ? "Last 7 days" : "Last 30 days" };
}

export interface Results { period: Period; label: string; values: Record<string, number | null>; hasCalls: boolean; planMinutes: number | null }

export async function getResults(actor: SignedInUser, period: Period, includeSimulated = false) {
  return act(actor, async (c): Promise<Results> => {
    await requireCap(c, "view_results", "You don't have access to Results.");
    const { from, to, label } = periodRange(period);
    const r = await c.query("SELECT metric, value FROM rc_results($1,$2,$3)", [from, to, includeSimulated]);
    const r2 = await c.query("SELECT metric, value FROM rc_results_v2($1,$2,$3)", [from, to, includeSimulated]);
    const values = Object.fromEntries([...r.rows, ...r2.rows].map((x) => [x.metric, x.value === null ? null : Number(x.value)]));
    const anyCalls = (await c.query(`SELECT EXISTS (SELECT 1 FROM calls WHERE ${includeSimulated ? "true" : "NOT is_simulated"}) AS e`)).rows[0].e;
    const plan = (await c.query(
      "SELECT (p.limits->>'voice_minutes')::int AS m FROM subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.status IN ('trialing','active','past_due','grace') ORDER BY s.created_at DESC LIMIT 1",
    )).rows[0];
    return { period, label, values, hasCalls: anyCalls, planMinutes: plan?.m ?? null };
  });
}

export async function exportResultsCsv(actor: SignedInUser, period: Period) {
  const r = await getResults(actor, period);
  if (!r.ok) return r;
  await act(actor, (c) => audit(c, actor, "results_exported", "clinic", actor.clinicId!, { period }));
  return { ok: true as const, value: toCsv(["metric", "value", "period", "how it is counted"], METRICS.map((m) => [m.label, r.value.values[m.key] ?? "", r.value.label, m.how])) };
}
