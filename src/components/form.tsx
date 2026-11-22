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

export function Select({ label, name, options, defaultValue, required, hint }: {
  label: string; name: string; options: [string, string][]; defaultValue?: string; required?: boolean; hint?: string;
}) {
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={defaultValue ?? ""} required={required}>
        {!required && <option value="">—</option>}
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function TextArea({ label, name, defaultValue, rows = 3, hint, maxLength }: { label: string; name: string; defaultValue?: string; rows?: number; hint?: string; maxLength?: number }) {
  const id = `f-${name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} name={name} defaultValue={defaultValue} rows={rows} maxLength={maxLength} />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Input(props: { label: string; name: string; type?: string; defaultValue?: string | number; required?: boolean; hint?: string; inputMode?: "text" | "tel" | "email" | "numeric"; autoComplete?: string; min?: string | number; max?: string | number; placeholder?: string }) {
  const id = `f-${props.name}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}{props.required === false ? <span className="opt"> (optional)</span> : null}</label>
      <input id={id} name={props.name} type={props.type ?? "text"} defaultValue={props.defaultValue} inputMode={props.inputMode}
        autoComplete={props.autoComplete ?? "off"} min={props.min} max={props.max} placeholder={props.placeholder} />
      {props.hint && <p className="field-hint">{props.hint}</p>}
    </div>
  );
}
