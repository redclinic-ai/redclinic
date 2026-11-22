"use client";

import { createContext, startTransition, useActionState, useContext, useEffect, useRef, type ReactNode } from "react";

export interface ActionState { error?: string; field?: string; message?: string; ok?: number; links?: { href: string; label: string; note?: string }[] }

const Pending = createContext(false);

/**
 * A form bound to a server action. Submits without React's automatic form reset, so whatever was typed
 * stays when the action returns an error. Shows the error at the top, marks the field it names and moves
 * focus there. `resetOnSuccess` clears the form after a successful save (for "add another" forms).
 */
export function ActionForm({ action, children, className, resetOnSuccess }: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  children: ReactNode; className?: string; resetOnSuccess?: boolean;
}) {
  const [state, run, pending] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    if (state.field) {
      const el = form.querySelector<HTMLElement>(`[name="${state.field}"]`);
      if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); }
    } else if (state.ok && resetOnSuccess) form.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      className={className}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
        const data = new FormData(e.currentTarget, submitter && "form" in submitter ? (submitter as HTMLButtonElement) : undefined);
        startTransition(() => run(data));
      }}
    >
      {state.error && (
        <div className="alert alert-error" role="alert">
          {state.error}
          {state.links && state.links.length > 0 && (
            <ul className="alert-links">{state.links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a>{l.note && <span className="muted"> · {l.note}</span>}</li>)}</ul>
          )}
        </div>
      )}
      {state.message && <div className="alert alert-success" role="status">{state.message}</div>}
      <Pending.Provider value={pending}>{children}</Pending.Provider>
    </form>
  );
}

export function Submit({ children, pending = "Saving…", variant = "primary", name, value, block }: {
  children: ReactNode; pending?: string; variant?: "primary" | "ghost" | "danger"; name?: string; value?: string; block?: boolean;
}) {
  const busy = useContext(Pending);
  return (
    <button type="submit" className={`btn btn-${variant}${block ? " btn-block" : ""}`} disabled={busy} aria-busy={busy} name={name} value={value}>
      {busy ? pending : children}
    </button>
  );
}
