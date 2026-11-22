"use client";

import { useActionState } from "react";
import { forgotPasswordAction, type FormState } from "../actions";
import { Field, SubmitButton } from "@/components/form";

export function ForgotForm() {
  const [state, action] = useActionState<FormState, FormData>(forgotPasswordAction, {});
  if (state.done) {
    return (
      <div className="alert alert-success" role="status">
        If that email has a RedClinic account, a reset link is on its way. It expires in 1 hour.
      </div>
    );
  }
  return (
    <form action={action} noValidate>
      <Field label="Email" name="email" type="email" inputMode="email" autoComplete="username" />
      <SubmitButton pendingText="Sending…">Send reset link</SubmitButton>
    </form>
  );
}
