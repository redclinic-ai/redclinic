"use server";

import { redirect } from "next/navigation";
import { login, logout, requestPasswordReset, setPasswordWithToken, signupClinic } from "@/lib/auth/service";
import { clearSessionCookie, requestMeta, sessionToken, setSessionCookie } from "@/lib/auth/session-cookie";

export interface FormState {
  error?: string;
  field?: string;
  done?: boolean;
  values?: Record<string, string>;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const email = str(form, "email");
  const r = await login(email, str(form, "password"), await requestMeta());
  if (!r.ok) return { error: r.error, values: { email } };
  await setSessionCookie(r.value.token, r.value.expiresAt);
  redirect("/home");
}

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  const values = {
    clinicName: str(form, "clinicName"),
    clinicType: str(form, "clinicType"),
    city: str(form, "city"),
    phone: str(form, "phone"),
    adminName: str(form, "adminName"),
    adminEmail: str(form, "adminEmail"),
    acceptTerms: form.get("acceptTerms") === "on" ? "on" : "",
  };
  const meta = await requestMeta();
  const r = await signupClinic(
    { ...values, clinicType: values.clinicType as "dental", password: str(form, "password"), acceptTerms: (values.acceptTerms === "on") as true },
    meta.ip,
  );
  if (!r.ok) return { error: r.error, field: r.field, values };
  const s = await login(values.adminEmail, str(form, "password"), meta);
  if (!s.ok) redirect("/login");
  await setSessionCookie(s.value.token, s.value.expiresAt);
  redirect(values.clinicType === "dental" ? "/home?welcome=dental" : "/home?welcome=1");
}

export async function forgotPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  await requestPasswordReset(str(form, "email"));
  return { done: true };
}

export async function setPasswordAction(_: FormState, form: FormData): Promise<FormState> {
  const password = str(form, "password");
  if (password !== str(form, "confirm")) return { error: "The two passwords don't match.", field: "confirm" };
  const r = await setPasswordWithToken(str(form, "token"), password);
  if (!r.ok) return { error: r.error, field: r.field };
  redirect("/login?password=set");
}

export async function logoutAction(): Promise<void> {
  await logout(await sessionToken());
  await clearSessionCookie();
  redirect("/login");
}
