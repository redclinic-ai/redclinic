"use client";

import Link from "next/link";
import { startTransition, useActionState, useRef } from "react";
import { askAction, type AskState } from "./actions";

const EXAMPLES = ["Missed appointments this week", "Calls today", "Summary of RC-10004", "Draft note for RC-10004: Review in 2 weeks", "Follow up Rahul Verma"];

export function AssistantChat() {
  const [state, run, pending] = useActionState<AskState, FormData>(askAction, {});
  const input = useRef<HTMLInputElement>(null);
  const send = (q: string, patient?: string) => {
    const f = new FormData(); f.set("q", q); if (patient) f.set("patient", patient);
    if (input.current) input.current.value = q;
    startTransition(() => run(f));
  };
  const a = state.answer;
  return (
    <>
      <form className="searchbar" onSubmit={(e) => { e.preventDefault(); send(input.current?.value ?? ""); }}>
        <label className="sr-only" htmlFor="q">Your question</label>
        <input ref={input} id="q" name="q" type="text" placeholder="e.g. Summary of RC-10004" autoComplete="off" />
        <button className="btn btn-primary" type="submit" disabled={pending}>{pending ? "Looking…" : "Ask"}</button>
      </form>
      {!a && !state.error && <div className="chips" style={{ marginTop: 12 }}>{EXAMPLES.map((e) => <button type="button" key={e} className="chip" onClick={() => send(e)}>{e}</button>)}</div>}
      {state.error && <div className="alert alert-error" role="alert">{state.error}</div>}
      {a && (
        <section className="card" aria-live="polite">
          <p className="strong">{a.answer}</p>
          {a.lines.length > 0 && (
            <ul className="mini-list">
              {a.lines.map((l, i) => (
                <li key={i} className={l.unavailable ? "muted" : undefined}>
                  {l.text}
                  {l.source && (a.answer.startsWith("More than one")
                    ? <> · <button type="button" className="linklike" onClick={() => send(state.q!, l.source!.id)}>this one</button></>
                    : <> · <Link className="small" href={l.source.href}>source</Link></>)}
                </li>
              ))}
            </ul>
          )}
          {a.suggestions && <div className="chips">{a.suggestions.map((s) => <button type="button" key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>}
        </section>
      )}
      <p className="muted small">Voice questions will be added once a speech provider is chosen.</p>
    </>
  );
}
