// Online consultations (V2). A private Jitsi video room per appointment: open source, nothing to install, works in
// the patient's phone browser. meet.jit.si (the free public Jitsi service) is the default for trying it; for real
// patients, RedClinic should run its own Jitsi server and set its domain here (docs/INTEGRATION_REQUIREMENTS.md).
// No fees or payments are handled here (no clinic revenue anywhere in RedClinic).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, firstIssue, requireCap, UserError } from "../authz";
import { queueWhatsApp } from "../whatsapp/service";

const Settings = z.object({
  enabled: z.boolean(),
  jitsiDomain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a domain like meet.example.in (no https://)."),
});

export async function getTelehealth(actor: SignedInUser) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const r = (await c.query("SELECT * FROM clinic_telehealth WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    return { enabled: !!r?.enabled, jitsiDomain: (r?.jitsi_domain ?? "meet.jit.si") as string };
  });
}

export async function saveTelehealth(actor: SignedInUser, input: { enabled: boolean; jitsiDomain: string }) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = Settings.safeParse(input);
    if (!p.success) throw firstIssue(p.error);
    await c.query(
      `INSERT INTO clinic_telehealth (clinic_id, enabled, jitsi_domain, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (clinic_id) DO UPDATE SET enabled=$2, jitsi_domain=$3, updated_by=$4, updated_at=now()`,
      [actor.clinicId, p.data.enabled, p.data.jitsiDomain, actor.userId]);
    await audit(c, actor, "telehealth_settings_saved", "clinic", actor.clinicId!, p.data);
    return p.data;
  });
}

export const meetingUrl = (domain: string, room: string) => `https://${domain}/${room}`;

/** Makes an appointment online and gives it a private room (a long random name nobody can guess). */
export async function makeOnline(actor: SignedInUser, appointmentId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_appointments");
    const t = (await c.query("SELECT * FROM clinic_telehealth WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    if (!t?.enabled) throw new UserError("Online consultations are switched off. Turn them on in Settings → Online consultations.");
    const a = (await c.query("SELECT id, status, appointment_type, online_meeting_ref FROM appointments WHERE id = $1", [appointmentId])).rows[0];
    if (!a) throw new UserError("Appointment not found.");
    if (!["scheduled", "confirmed"].includes(a.status)) throw new UserError("Only upcoming appointments can be made online.");
    const room = a.online_meeting_ref ?? `RedClinic-${randomBytes(16).toString("hex")}`;
    await c.query("UPDATE appointments SET appointment_type = 'online', online_meeting_ref = $2, updated_at = now() WHERE id = $1", [appointmentId, room]);
    await audit(c, actor, "appointment_made_online", "appointment", appointmentId);
    return { url: meetingUrl(t.jitsi_domain, room) };
  });
}

export async function makeInClinic(actor: SignedInUser, appointmentId: string) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_appointments");
    const r = await c.query("UPDATE appointments SET appointment_type = 'in_clinic', online_meeting_ref = NULL, updated_at = now() WHERE id = $1 AND status IN ('scheduled','confirmed') RETURNING id", [appointmentId]);
    if (!r.rowCount) throw new UserError("Only upcoming appointments can be changed.");
    await audit(c, actor, "appointment_made_in_clinic", "appointment", appointmentId);
    return true;
  });
}

export async function onlineDetails(actor: SignedInUser, appointmentId: string) {
  return act(actor, async (c) => {
    const a = (await c.query("SELECT appointment_type, online_meeting_ref FROM appointments WHERE id = $1", [appointmentId])).rows[0];
    const t = (await c.query("SELECT enabled, jitsi_domain FROM clinic_telehealth WHERE clinic_id = $1", [actor.clinicId])).rows[0];
    return {
      available: !!t?.enabled, online: a?.appointment_type === "online",
      url: a?.appointment_type === "online" && a.online_meeting_ref && t ? meetingUrl(t.jitsi_domain, a.online_meeting_ref) : null,
      publicService: (t?.jitsi_domain ?? "meet.jit.si") === "meet.jit.si",
    };
  });
}

/** Sends the joining link on WhatsApp (needs WhatsApp connected and the patient's agreement). */
export async function sendJoinLink(actor: SignedInUser, appointmentId: string) {
  const d = await onlineDetails(actor, appointmentId);
  if (!d.ok) return d;
  if (!d.value.url) return { ok: false as const, error: "Make the appointment online first." };
  const a = await act(actor, async (c) => {
    await requireCap(c, "manage_appointments");
    return (await c.query("SELECT patient_id FROM appointments WHERE id = $1", [appointmentId])).rows[0];
  });
  if (!a.ok || !a.value) return { ok: false as const, error: "Appointment not found." };
  const q = await queueWhatsApp(actor.clinicId!, { patientId: a.value.patient_id, template: "online_consult_link", appointmentId, vars: { link: d.value.url } });
  if (q.mode === "prohibited" || q.mode === "suggest") return { ok: false as const, error: q.reason };
  return { ok: true as const, value: q.mode === "approval_required" ? "The link is waiting for approval in Approvals." : "The link will be sent on WhatsApp." };
}
