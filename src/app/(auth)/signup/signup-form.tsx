"use client";

import { useActionState } from "react";
import { signupAction, type FormState } from "../actions";
import { Field, FormError, SubmitButton } from "@/components/form";

const TYPES: [string, string][] = [
  ["dental", "Dental"],
  ["dermatology", "Dermatology / skin"],
  ["urology", "Urology"],
  ["ent", "ENT"],
  ["ophthalmology", "Eye care"],
  ["physiotherapy", "Physiotherapy"],
  ["general", "General practice"],
  ["diagnostic_centre", "Diagnostic centre"],
  ["other", "Other"],
];

export function SignupForm({ termsWording }: { termsWording: string }) {
  const [state, action] = useActionState<FormState, FormData>(signupAction, {});
  const v = state.values ?? {};
  const err = (f: string) => (state.field === f ? state.error : undefined);
  const generalError = state.error && !["clinicName", "phone", "adminName", "adminEmail", "password", "acceptTerms"].includes(state.field ?? "") ? state.error : undefined;
  return (
    <form action={action} noValidate>
      <FormError message={generalError} />
      <fieldset>
        <legend>Your clinic</legend>
        <Field label="Clinic name" name="clinicName" autoComplete="organization" defaultValue={v.clinicName} error={err("clinicName")} />
        <div className="field">
          <label htmlFor="f-clinicType">Type of clinic</label>
          <select id="f-clinicType" name="clinicType" defaultValue={v.clinicType ?? "dental"}>
            {TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <Field label="City" name="city" autoComplete="address-level2" required={false} defaultValue={v.city} />
        <Field label="Clinic phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={v.phone} error={err("phone")} />
      </fieldset>
      <fieldset>
        <legend>You (clinic admin)</legend>
        <Field label="Your name" name="adminName" autoComplete="name" defaultValue={v.adminName} error={err("adminName")} />
        <Field label="Email" name="adminEmail" type="email" inputMode="email" autoComplete="email" defaultValue={v.adminEmail} error={err("adminEmail")} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." error={err("password")} />
      </fieldset>
      <details className="terms">
        <summary>Read the terms</summary>
        <p>{termsWording}</p>
      </details>
      <label className="check">
        <input type="checkbox" name="acceptTerms" required defaultChecked={v.acceptTerms === "on"} />
        <span>I agree to the terms on behalf of the clinic.</span>
      </label>
      {err("acceptTerms") && <p className="field-error">{err("acceptTerms")}</p>}
      <SubmitButton pendingText="Creating account…">Create account</SubmitButton>
    </form>
  );
}
