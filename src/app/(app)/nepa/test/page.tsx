import { requireUser } from "@/lib/auth/session-cookie";
import { runPolicyTests, simulate } from "@/lib/nepa/simulator";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Test NEPA · RedClinic" };

const EXAMPLE = "Do you have parking?\nI want to book an appointment\nyes\nRavi Kumar";

export default async function TestPage({ searchParams }: { searchParams: Promise<{ agent?: string; says?: string; phone?: string; live?: string; policies?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const agent = ["receptionist", "reminder", "lead_followup", "feedback"].includes(sp.agent ?? "") ? sp.agent! : "receptionist";
  const run = sp.says !== undefined ? await simulate(user, { agentKind: agent, callerSays: (sp.says ?? "").split("\n"), callerPhone: sp.phone || undefined, useDrafts: sp.live !== "1" }) : null;
  const policies = sp.policies === "1" ? await runPolicyTests(user, agent) : null;
  return (
    <>
      <PageHeader title="Test NEPA" subtitle="Try a conversation before patients do. Nothing here is saved: no bookings, no alerts, no records." />
      <form className="card">
        <div className="row2">
          <div className="field"><label htmlFor="agent">Agent</label>
            <select id="agent" name="agent" defaultValue={agent}><option value="receptionist">Receptionist</option><option value="reminder">Appointment reminders</option><option value="lead_followup">Enquiry follow-up</option><option value="feedback">After-treatment check-in</option></select></div>
          <div className="field"><label htmlFor="phone">Caller's number (optional)</label><input id="phone" name="phone" type="tel" defaultValue={sp.phone} placeholder="Use a patient's number to test their appointments" /></div>
        </div>
        <div className="field"><label htmlFor="says">What the caller says, one line per turn</label>
          <textarea id="says" name="says" rows={5} defaultValue={sp.says ?? EXAMPLE} /></div>
        <label className="check"><input type="checkbox" name="live" value="1" defaultChecked={sp.live === "1"} /> <span>Use live settings (otherwise your unpublished changes are tested)</span></label>
        <div className="form-actions">
          <button className="btn btn-primary" type="submit">Run conversation</button>
          <button className="btn btn-ghost" type="submit" name="policies" value="1">Run RedClinic safety tests</button>
        </div>
      </form>
      {run && (run.ok ? (
        <section className="card" aria-label="Result">
          <h2 className="h2">Conversation <span className="badge badge-sim">Simulated</span></h2>
          <ol className="chat">
            {run.value.transcript.map((t, i) => <li key={i} className={`bubble ${t.speaker}`}><span className="sr-only">{t.speaker === "nepa" ? "NEPA" : "Caller"}: </span>{t.text}</li>)}
          </ol>
          <dl className="facts small">
            <dt>Understood as</dt><dd>{run.value.intent ?? "—"}</dd>
            <dt>Outcome</dt><dd>{run.value.outcome ?? "—"}</dd>
            <dt>Actions</dt><dd>{run.value.actions.length ? run.value.actions.map((a) => `${a.tool}: ${a.outcome.status}`).join(", ") : "None"}</dd>
            <dt>Versions used</dt><dd>Clinic {run.value.versions.clinicConfig ? `v${run.value.versions.clinicConfig}` : "defaults"}, agent {run.value.versions.agentConfig ? `v${run.value.versions.agentConfig}` : "defaults"}, {Object.keys(run.value.versions.policies as object).length} RedClinic policies</dd>
          </dl>
          {run.value.conflicts.length > 0 && <div className="alert alert-error"><ul className="alert-links">{run.value.conflicts.map((c, i) => <li key={i}>{c.message} {c.resolution}</li>)}</ul></div>}
          <details className="more-fields"><summary>Show the full instructions NEPA follows</summary><pre className="instructions">{run.value.instructions}</pre></details>
        </section>
      ) : <div className="alert alert-error">{run.error}</div>)}
      {policies && (policies.ok ? (
        <section className="card" aria-label="Safety tests">
          <h2 className="h2">RedClinic safety tests · {policies.value.filter((p) => p.passed).length} of {policies.value.length} passed</h2>
          <ul className="mini-list">
            {policies.value.map((p) => (
              <li key={p.id}><span className={`badge ${p.passed ? "badge-ok" : "badge-bad"}`}>{p.passed ? "Pass" : "Fail"}</span> “{p.says}” <div className="muted small">NEPA: {p.reply}</div></li>
            ))}
          </ul>
        </section>
      ) : <div className="alert alert-error">{policies.error}</div>)}
    </>
  );
}
