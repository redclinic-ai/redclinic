import { CONDITIONS, EVENTS, PURPOSES, type Definition } from "@/lib/workflows/definition";
import { Input } from "@/components/form";

function split(min: number) {
  if (min > 0 && min % 10080 === 0) return { amount: min / 10080, unit: "weeks" };
  if (min > 0 && min % 1440 === 0) return { amount: min / 1440, unit: "days" };
  if (min > 0 && min % 60 === 0) return { amount: min / 60, unit: "hours" };
  return { amount: min, unit: "minutes" };
}

/** The workflow form: a trigger and up to six plain-language step rows. */
export function WorkflowEditor({ name, def }: { name: string; def: Definition }) {
  const rows = Array.from({ length: 6 }, (_, i) => def.steps[i]);
  return (
    <>
      <Input label="Name" name="name" defaultValue={name} />
      <fieldset>
        <legend>Starts</legend>
        <div className="row3">
          <div className="field"><label htmlFor="event">When</label>
            <select id="event" name="event" defaultValue={def.trigger.event}>{Object.entries(EVENTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <Input label="Months (for “months after”)" name="months" type="number" defaultValue={def.trigger.months ?? 6} required={false} />
          <Input label="Weeks (for “weeks after”)" name="weeks" type="number" defaultValue={def.trigger.weeks ?? 4} required={false} />
        </div>
        <Input label="Only for these treatments (comma-separated, optional)" name="serviceMatch" defaultValue={(def.trigger.serviceMatch ?? []).join(", ")} required={false} hint="Matched against the treatment or reason of the appointment, e.g. root canal, braces." />
      </fieldset>
      <fieldset>
        <legend>Steps</legend>
        <div className="step-rows">
          {rows.map((s, i) => {
            const t = s ? split(s.beforeAppointmentMinutes ?? s.afterMinutes ?? 0) : { amount: 1, unit: "days" };
            return (
              <div key={i} className="step-row">
                <input type="hidden" name={`s${i}_key`} defaultValue={s?.key ?? ""} />
                <span className="step-no">{i + 1}</span>
                <select name={`s${i}_action`} defaultValue={s?.action ?? "none"} aria-label={`Step ${i + 1}: what happens`}>
                  <option value="none">— no step —</option><option value="call">NEPA calls</option><option value="attention">Tell staff</option>
                </select>
                <input name={`s${i}_amount`} type="number" min={0} defaultValue={t.amount} aria-label={`Step ${i + 1}: how long`} className="num" />
                <select name={`s${i}_unit`} defaultValue={t.unit} aria-label={`Step ${i + 1}: unit`}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option></select>
                <select name={`s${i}_when`} defaultValue={s?.beforeAppointmentMinutes !== undefined ? "before" : "after"} aria-label={`Step ${i + 1}: before or after`}>
                  <option value="after">after it starts</option><option value="before">before the appointment</option>
                </select>
                <select name={`s${i}_purpose`} defaultValue={s?.purpose ?? "follow_up"} aria-label={`Step ${i + 1}: call purpose`}>{Object.entries(PURPOSES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                <select name={`s${i}_onlyIf`} defaultValue={s?.onlyIf ?? "always"} aria-label={`Step ${i + 1}: condition`}>{Object.entries(CONDITIONS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                <input name={`s${i}_reason`} defaultValue={s?.reason ?? ""} placeholder="Message for staff (for “Tell staff”)" aria-label={`Step ${i + 1}: message for staff`} className="reason" />
              </div>
            );
          })}
        </div>
        <p className="field-hint">At most 3 calls per workflow. Each step's condition is checked when it is due; if it no longer applies, the workflow stops for that patient. Patients who withdrew consent are never called.</p>
      </fieldset>
    </>
  );
}
