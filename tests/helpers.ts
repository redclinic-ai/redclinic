import { randomUUID } from "node:crypto";
import { SimulatedEmailAdapter, setEmailAdapter } from "@/lib/email";
import { signupClinic, login, resolveSession, type SignedInUser } from "@/lib/auth/service";

export const PASSWORD = "correct horse battery";

export function freshOutbox(): SimulatedEmailAdapter {
  const a = new SimulatedEmailAdapter();
  setEmailAdapter(a);
  return a;
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export async function newClinic(clinicType: "dental" | "dermatology" = "dental") {
  const adminEmail = uniqueEmail("admin");
  const r = await signupClinic(
    { clinicName: "Smile Dental", clinicType, city: "Pune", phone: "+91 98000 00000", adminName: "Dr Admin", adminEmail, password: PASSWORD, acceptTerms: true },
    null, // no IP: the per-network sign-up limit is tested on its own in security.test.ts
  );
  if (!r.ok) throw new Error(r.error);
  const session = await signIn(adminEmail);
  return { ...r.value, adminEmail, admin: session.user, token: session.token };
}

export async function signIn(email: string, password = PASSWORD): Promise<{ token: string; user: SignedInUser }> {
  const r = await login(email, password, { ip: "127.0.0.1", userAgent: "vitest" });
  if (!r.ok) throw new Error(r.error);
  const user = await resolveSession(r.value.token);
  if (!user) throw new Error("session did not resolve");
  return { token: r.value.token, user };
}

export function linkToken(text: string): string {
  const m = text.match(/set-password\?token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("no link in email");
  return m[1];
}

import { withContext } from "@/lib/db";
import { contextOf, inviteStaff, setPasswordWithToken } from "@/lib/auth/service";
import type { SimulatedEmailAdapter as Outbox } from "@/lib/email";

export async function newPatient(admin: SignedInUser, name = "Asha Kumar"): Promise<string> {
  return withContext(contextOf(admin), async (c) =>
    (await c.query("INSERT INTO patients (clinic_id, name, phone) VALUES ($1,$2,'9800000000') RETURNING id", [admin.clinicId, name])).rows[0].id,
  );
}

export async function addStaff(admin: SignedInUser, role: "doctor" | "receptionist" | "clinic_manager", outbox: Outbox) {
  const email = uniqueEmail(role);
  const r = await inviteStaff(admin, { displayName: `Test ${role}`, email, role });
  if (!r.ok) throw new Error(r.error);
  const msg = outbox.outbox.filter((m) => m.to === email).pop()!;
  const set = await setPasswordWithToken(linkToken(msg.text), PASSWORD);
  if (!set.ok) throw new Error(set.error);
  return (await signIn(email)).user;
}
