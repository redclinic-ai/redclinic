import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getCall } from "@/lib/calls/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { endTestCallAction, sayAction, startTestCallAction } from "../actions";

export const metadata = { title: "Test call · RedClinic" };

export default async function TestCallPage({ searchParams }: { searchParams: Promise<{ call?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "edit_workflow", "view_calls");
  const { call } = await searchParams;
  const r = call ? await getCall(user, call) : null;
  if (call && (!r || !r.ok)) redirect("/calls/test");
  const c = r?.ok ? r.value : null;
  const live = c?.status === "in_progress";
  return (
    <>
      <PageHeader title="Test call" back={{ href: "/calls", label: "Calls" }}
        subtitle="Talk to NEPA as a patient would. It uses your live settings and creates a real call record marked as a test. Bookings it asks for go to Approvals as tests." />
      {!c ? (
        <form action={startTestCallAction} className="card form-narrow">
          <div className="field"><label htmlFor="phone">Call as (optional patient mobile number)</label><input id="phone" name="phone" type="tel" placeholder="Use a patient's number to test their appointments" /></div>
          <div className="field"><label htmlFor="lang">NEPA starts in</label><select id="lang" name="lang" defaultValue=""><option value="">Clinic's preferred language</option><option value="en">English</option><option value="hi">Hindi</option><option value="kn">Kannada</option></select></div>
          <button className="btn btn-primary" type="submit">Start test call</button>
        </form>
      ) : (
        <section className="card">
          <ol className="chat">{(c.transcript ?? []).map((t) => <li key={t.id} className={`bubble ${t.speaker}`}><span className="sr-only">{t.speaker === "nepa" ? "NEPA" : "You"}: </span>{t.original}</li>)}</ol>
          {live ? (
            <>
              <ActionForm action={sayAction} className="say-bar" resetOnSuccess>
                <input type="hidden" name="callId" value={c.id} />
                <label className="sr-only" htmlFor="text">What you say</label>
                <input id="text" name="text" autoFocus autoComplete="off" placeholder="Type what the caller says…" className="note" />
                <Submit pending="…">Say</Submit>
              </ActionForm>
              <form action={endTestCallAction}><input type="hidden" name="callId" value={c.id} /><button className="btn btn-ghost" type="submit">Hang up and see the record</button></form>
            </>
          ) : <p><a className="btn btn-primary" href={`/calls/${c.id}?test=1`}>See the call record</a> <a className="btn btn-ghost" href="/calls/test">New test call</a></p>}
        </section>
      )}
    </>
  );
}
