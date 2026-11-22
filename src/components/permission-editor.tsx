import { ACTIONS, MODES, type Action, type Mode } from "@/lib/nepa/permissions";

const MODE_LABEL: Record<Mode, string> = { automatic: "Do it", approval_required: "Ask staff first", suggest: "Only suggest", prohibited: "Never" };

/** One row per action. Options above the allowed maximum are not offered. */
export function PermissionEditor({ value, limits, legend }: { value: Partial<Record<Action, Mode>>; limits?: Partial<Record<Action, Mode>>; legend: string }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="perm-grid">
        {(Object.keys(ACTIONS) as Action[]).map((a) => {
          const maxRank = Math.min(MODES.indexOf(ACTIONS[a].max as Mode), limits?.[a] ? MODES.indexOf(limits[a]!) : 99);
          const options = MODES.filter((m) => MODES.indexOf(m) <= maxRank);
          return (
            <div key={a} className="perm-row">
              <label htmlFor={`perm_${a}`}>{ACTIONS[a].label}</label>
              <select id={`perm_${a}`} name={`perm_${a}`} defaultValue={value[a] ?? (MODES.indexOf(ACTIONS[a].default as Mode) <= maxRank ? ACTIONS[a].default : options.at(-1))}>
                {[...options].reverse().map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
            </div>
          );
        })}
      </div>
      <p className="field-hint">“Do it” for outgoing calls and reminders also needs the workflow itself switched to automatic. Withdrawn consent always stops calls.</p>
    </fieldset>
  );
}
