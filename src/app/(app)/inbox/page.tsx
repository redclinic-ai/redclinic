import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listAttention } from "@/lib/attention/service";
import { Badge, Empty, Flash, fmtDateTime, PageHeader, Simulated } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { addAction, itemAction } from "./actions";

export const metadata = { title: "Needs attention · RedClinic" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ view?: string; mine?: string; q?: string; sim?: string; ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "manage_attention", "view_approvals");
  const sp = await searchParams;
  const view = (["active", "snoozed", "resolved"].includes(sp.view ?? "") ? sp.view : "active") as "active" | "snoozed" | "resolved";
  const r = await listAttention(user, { view, mine: sp.mine === "1", q: sp.q, includeSimulated: sp.sim === "1" });
  if (!r.ok) return <p>{r.error}</p>;
  const { items, counts } = r.value;
  const can = caps.has("manage_attention");
  const tab = (v: string, label: string) => <Link href={`/inbox?view=${v}`} aria-current={view === v ? "page" : undefined}>{label}</Link>;
  return (
    <>
      <Flash ok={sp.ok} />
      <PageHeader title="Needs attention" subtitle={counts.open === 0 ? "All clear." : `${counts.open} to do${counts.urgent ? `, ${counts.urgent} urgent` : ""}. Urgent first, then oldest.`} />
      <nav className="subnav" aria-label="Filter">
        {tab("active", `To do (${counts.open})`)}{tab("snoozed", `Snoozed (${counts.snoozed})`)}{tab("resolved", "Done")}
        <Link href={`/inbox?view=${view}&mine=1`} aria-current={sp.mine === "1" ? "page" : undefined}>Assigned to me</Link>
      </nav>
      {view === "resolved" && (
        <form className="searchbar" role="search"><input type="hidden" name="view" value="resolved" />
          <input type="search" name="q" defaultValue={sp.q} placeholder="Search done items by patient or reason" aria-label="Search" />
          <button className="btn btn-ghost" type="submit">Search</button></form>
      )}
      {items.length === 0 ? <Empty title={view === "active" ? "Nothing needs attention" : "Nothing here"} /> : (
        <ul className="list">
          {items.map((i) => (
            <li key={i.id} className={`list-item att${i.urgency === 1 ? " is-urgent" : ""}`}>
              <div className="att-head">
                {i.urgency === 1 && <Badge status="failed" label="Urgent" />}
                <strong>{i.label}</strong>
                {i.isSimulated && <Simulated />}
                <span className="muted small">{fmtDateTime(i.createdAt)}</span>
              </div>
              {i.patientId && <p className="att-who"><Link href={`/patients/${i.patientId}`}>{i.patientName}</Link> <span className="muted small">{i.patientCode}</span></p>}
              <p className="att-why">{i.reason}</p>
              {i.assignedToName && <p className="muted small">Assigned to {i.assignedToName}</p>}
              {i.status === "resolved" && <p className="muted small">Done {fmtDateTime(i.resolvedAt)}{i.resolvedByName ? ` by ${i.resolvedByName}` : ""}: {i.resolution}</p>}
              {i.status === "snoozed" && <p className="muted small">Back on the list {fmtDateTime(i.snoozedUntil)}</p>}
              <div className="form-actions">
                {i.status !== "resolved" && i.patientPhone && ["Call back", "Call to confirm", "Call to rebook"].includes(i.nextAction) && <a className="btn btn-primary" href={`tel:${i.patientPhone.replace(/\s/g, "")}`}>{i.nextAction}</a>}
                {i.status !== "resolved" && i.appointmentId && <Link className="btn btn-ghost" href={`/appointments/${i.appointmentId}`}>{["Reschedule", "Cancel appointment"].includes(i.nextAction) ? i.nextAction : "Open appointment"}</Link>}
                {i.status !== "resolved" && i.approvalId && <Link className="btn btn-primary" href={`/approvals#${i.approvalId}`}>Review</Link>}
                {i.callId && <Link className="btn btn-ghost" href={`/calls/${i.callId}`}>Open call</Link>}
                {i.kind === "whatsapp_reply" && i.patientId && <Link className="btn btn-primary" href={`/messages/${i.patientId}`}>Open messages</Link>}
              </div>
              {can && (
                <ActionForm action={itemAction} className="att-ops">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="back" value={`/inbox?view=${view}${sp.mine === "1" ? "&mine=1" : ""}`} />
                  {i.status === "resolved" ? <Submit variant="ghost" name="op" value="reopen">Put back on the list</Submit> : (
                    <>
                      <label className="sr-only" htmlFor={`n-${i.id}`}>What was done</label>
                      <input id={`n-${i.id}`} name="note" placeholder="What was done (optional)" className="note" />
                      <Submit name="op" value="resolve" pending="…">Mark done</Submit>
                      <details className="menu"><summary className="btn btn-ghost">More</summary>
                        <div className="menu-body">
                          <Submit variant="ghost" name="op" value="snooze:1h">Snooze 1 hour</Submit>
                          <Submit variant="ghost" name="op" value="snooze:3h">Snooze 3 hours</Submit>
                          <Submit variant="ghost" name="op" value="snooze:tomorrow">Snooze till tomorrow 9 am</Submit>
                          {i.assignedTo === user.userId ? <Submit variant="ghost" name="op" value="unassign">Unassign me</Submit> : <Submit variant="ghost" name="op" value="assign_me">Assign to me</Submit>}
                        </div>
                      </details>
                    </>
                  )}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      {can && view === "active" && (
        <details className="card more-fields">
          <summary>Add something to the list</summary>
          <ActionForm action={addAction} resetOnSuccess>
            <Select label="Type" name="kind" required defaultValue="complaint" options={[["complaint", "Complaint"], ["unanswered_question", "Question to answer"], ["reschedule_request", "Wants to reschedule"], ["cancellation_request", "Wants to cancel"]]} />
            <Input label="What needs doing" name="reason" />
            <label className="check"><input type="checkbox" name="urgent" /> <span>Urgent</span></label>
            <Submit>Add</Submit>
          </ActionForm>
        </details>
      )}
      <p className="small muted"><Link href={`/inbox?view=${view}&sim=${sp.sim === "1" ? "0" : "1"}`}>{sp.sim === "1" ? "Hide" : "Show"} test (simulated) items</Link></p>
    </>
  );
}
