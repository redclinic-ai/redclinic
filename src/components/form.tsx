"use client";

import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";

export function Field(props: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  defaultValue?: string;
  required?: boolean;
  hint?: string;
  error?: string;
  inputMode?: "text" | "email" | "tel";
  minLength?: number;
}) {
  const id = `f-${props.name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        name={props.name}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete}
        defaultValue={props.defaultValue}
        required={props.required ?? true}
        inputMode={props.inputMode}
        minLength={props.minLength}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? `${id}-err` : props.hint ? `${id}-hint` : undefined}
      />
      {props.error ? (
        <p className="field-error" id={`${id}-err`}>{props.error}</p>
      ) : props.hint ? (
        <p className="field-hint" id={`${id}-hint`}>{props.hint}</p>
      ) : null}
    </div>
  );
}

export function SubmitButton({ children, pendingText }: { children: ReactNode; pendingText: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending} aria-busy={pending}>
      {pending ? pendingText : children}
    </button>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="alert alert-error" role="alert">{message}</div>;
}
