"use server";

import { redirect } from "next/navigation";
import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { DAYS, deleteFaq, saveConsentWording, saveFaq, saveService, updateClinicProfile } from "@/lib/clinic/service";
import { deactivateUser, inviteStaff } from "@/lib/auth/service";
import { setStaffCapabilities } from "@/lib/staff/service";
import { decideGrant, saveDataPolicy } from "@/lib/privacy/service";

export async function saveProfileAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const workingHours = Object.fromEntries(DAYS.map((d) => [d, checked(f, `${d}_open`) ? { open: field(f, `${d}_from`), close: field(f, `${d}_to`) } : null]));
  const r = await updateClinicProfile(user, {
    name: field(f, "name"), address: field(f, "address"), city: field(f, "city"), phone: field(f, "phone"), email: field(f, "email"),
    languages: f.getAll("languages").map(String) as ("en" | "hi" | "kn")[], workingHours,
    defaultAppointmentMinutes: field(f, "defaultAppointmentMinutes"),
  });
  return finish(r, { message: "Clinic details saved.", revalidate: ["/settings"] });
}

export async function saveServiceAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await saveService(user, {
    id: field(f, "id") || undefined, name: field(f, "name"), durationMinutes: field(f, "durationMinutes"),
    description: field(f, "description"), enabled: field(f, "id") ? checked(f, "enabled") : true,
  });
  return finish(r, { message: field(f, "id") ? "Service saved." : "Service added.", revalidate: ["/settings/services"] });
}

export async function saveFaqAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (f.get("delete")) {
    return finish(await deleteFaq(user, field(f, "id")), { message: "Question removed.", revalidate: ["/settings/faqs"] });
  }
  const r = await saveFaq(user, {
    id: field(f, "id") || undefined, question: field(f, "question"), answer: field(f, "answer"),
    language: field(f, "language") as "en", enabled: field(f, "id") ? checked(f, "enabled") : true,
  });
  return finish(r, { message: field(f, "id") ? "Saved." : "Question added.", revalidate: ["/settings/faqs"] });
}

export async function saveConsentAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await saveConsentWording(user, field(f, "language") as "en", field(f, "wording"));
  return finish(r, { message: "New wording saved. It is used for consent recorded from now on.", revalidate: ["/settings/consent"] });
}

export async function inviteAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await inviteStaff(user, { displayName: field(f, "displayName"), email: field(f, "email"), role: field(f, "role") as "doctor" });
  return finish(r, { redirect: (v) => `/settings/staff/${v.userId}?ok=invited`, revalidate: ["/settings/staff"] });
}

export async function permissionsAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  if (f.get("deactivate")) {
    const r = await deactivateUser(user, id);
    if (!r.ok) return { error: r.error };
    redirect(`/settings/staff?ok=deactivated`);
  }
  const r = await setStaffCapabilities(user, id, f.getAll("cap").map(String));
  return finish(r, { message: "Permissions saved. They apply straight away.", revalidate: ["/settings/staff"] });
}

export async function saveDataPolicyAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await saveDataPolicy(user, {
    superAccess: field(f, "superAccess"), recordingDays: field(f, "recordingDays"), transcriptDays: field(f, "transcriptDays"),
    assistantLogDays: field(f, "assistantLogDays"), telephonyEventDays: field(f, "telephonyEventDays"),
  });
  return finish(r, { message: "Privacy settings saved.", revalidate: ["/settings/privacy"] });
}

export async function decideGrantAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const decision = field(f, "decision") as "approve" | "deny" | "revoke";
  const r = await decideGrant(user, field(f, "id"), decision);
  return finish(r, { redirect: `/settings/privacy?ok=${decision === "approve" ? "approved" : decision === "deny" ? "denied" : "revoked"}`, revalidate: ["/settings/privacy"] });
}
