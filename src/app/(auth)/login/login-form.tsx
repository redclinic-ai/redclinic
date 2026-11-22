"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "../actions";
import { Field, FormError, SubmitButton } from "@/components/form";

export function LoginForm() {
  const [state, action] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} noValidate>
      <FormError message={state.error} />
      <Field label="Email" name="email" type="email" inputMode="email" autoComplete="username" defaultValue={state.values?.email} />
      <Field label="Password" name="password" type="password" autoComplete="current-password" />
      <SubmitButton pendingText="Signing in…">Sign in</SubmitButton>
    </form>
  );
}
