// Clinic phone setup: the clinic's own number, the RedClinic number to forward to (assigned by RedClinic once a
// telephony provider is live), a staff mobile for handover, and the forwarding mode.
import { z } from "zod";
import type { SignedInUser } from "../auth/service";
import { act, audit, requireCap, UserError } from "../authz";

export interface PhoneSetup { id: string | null; clinicNumber: string; receptionistNumber: string | null; fallbackNumber: string; forwardingMode: string; status: string; verifiedAt: Date | null }

export async function getPhoneSetup(actor: SignedInUser) {
  return act(actor, async (c): Promise<PhoneSetup> => {
    const x = (await c.query("SELECT * FROM clinic_phone_numbers WHERE status <> 'disabled' ORDER BY created_at DESC LIMIT 1")).rows[0];
    return x ? { id: x.id, clinicNumber: x.clinic_number, receptionistNumber: x.receptionist_number, fallbackNumber: x.fallback_number ?? "", forwardingMode: x.forwarding_mode, status: x.status, verifiedAt: x.verified_at }
      : { id: null, clinicNumber: "", receptionistNumber: null, fallbackNumber: "", forwardingMode: "when_busy_or_unanswered", status: "pending", verifiedAt: null };
  });
}

const phone = z.string().trim().regex(/^[0-9+\-\s]{7,20}$/, "Enter a valid phone number.");
export async function savePhoneSetup(actor: SignedInUser, input: { clinicNumber: string; fallbackNumber: string; forwardingMode: string }) {
  return act(actor, async (c) => {
    await requireCap(c, "manage_settings");
    const p = z.object({ clinicNumber: phone, fallbackNumber: phone, forwardingMode: z.enum(["always", "when_busy_or_unanswered", "after_hours"]) }).safeParse(input);
    if (!p.success) throw new UserError(p.error.issues[0].message, String(p.error.issues[0].path[0]));
    const cur = (await c.query("SELECT id FROM clinic_phone_numbers WHERE status <> 'disabled' ORDER BY created_at DESC LIMIT 1")).rows[0];
    if (cur) await c.query("UPDATE clinic_phone_numbers SET clinic_number=$2, fallback_number=$3, forwarding_mode=$4 WHERE id=$1", [cur.id, p.data.clinicNumber, p.data.fallbackNumber, p.data.forwardingMode]);
    else await c.query("INSERT INTO clinic_phone_numbers (clinic_id, clinic_number, fallback_number, forwarding_mode) VALUES ($1,$2,$3,$4)", [actor.clinicId, p.data.clinicNumber, p.data.fallbackNumber, p.data.forwardingMode]);
    await audit(c, actor, "phone_setup_saved", "clinic", actor.clinicId!);
    return null;
  });
}

/** Call-forwarding codes used by Indian mobile networks (Jio, Airtel, Vi, BSNL) and most landlines. */
export function forwardingCodes(target: string) {
  const n = target.replace(/[^\d+]/g, "");
  return [
    { mode: "always", label: "Send every call to NEPA", code: `**21*${n}#` },
    { mode: "when_busy_or_unanswered", label: "When no one answers", code: `**61*${n}#` },
    { mode: "when_busy_or_unanswered", label: "When the line is busy", code: `**67*${n}#` },
    { mode: "when_busy_or_unanswered", label: "When the phone is switched off or unreachable", code: `**62*${n}#` },
    { mode: "off", label: "Turn all forwarding off", code: "##002#" },
  ];
}
