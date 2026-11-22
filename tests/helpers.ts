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
    "127.0.0.1",
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
