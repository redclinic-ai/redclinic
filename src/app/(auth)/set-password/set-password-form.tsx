"use client";

import { useActionState } from "react";
import { setPasswordAction, type FormState } from "../actions";
import { Field, FormError, SubmitButton } from "@/components/form";

export function SetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState<FormState, FormData>(setPasswordAction, {});
  const err = (f: string) => (state.field === f ? state.error : undefined);
  return (
    <form action={action} noValidate>
      <FormError message={state.field ? undefined : state.error} />
      <input type="hidden" name="token" value={token} />
      <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." error={err("password")} />
      <Field label="Type it again" name="confirm" type="password" autoComplete="new-password" error={err("confirm")} />
      <SubmitButton pendingText="Saving…">Save password</SubmitButton>
    </form>
  );
}
