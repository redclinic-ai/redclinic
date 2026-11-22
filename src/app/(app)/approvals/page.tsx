import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listApprovals } from "@/lib/nepa/approvals";
import { Badge, Empty, Flash, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { decideAction } from "./actions";

export const metadata = { title: "Approvals · RedClinic" };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ view?: string; ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_approvals", "approve_actions");
  const sp = await searchParams;
  const view = sp.view === "decided" ? "decided" : "pending";
  const r = await listApprovals(user, view);
  if (!r.ok) return <p>{r.error}</p>;
  const canDecide = caps.has("approve_actions");
  return (
    <>
      <Flash ok={sp.ok} />
      <PageHeader title="Approvals" subtitle="Things NEPA prepared that need a person to say yes. Nothing happens until someone approves." />
      <nav className="subnav"><Link href="/approvals" aria-current={view === "pending" ? "page" : undefined}>Waiting</Link><Link href="/approvals?view=decided" aria-current={view === "decided" ? "page" : undefined}>Decided</Link></nav>
      {r.value.length === 0 ? <Empty title={view === "pending" ? "Nothing waiting for approval" : "No decisions yet"} /> : (
        <ul className="list">
          {r.value.map((a) => (
            <li key={a.id} id={a.id} className="list-item">
              <div className="att-head"><strong>{a.actionLabel}</strong> {a.mode === "suggest" && <Badge status="draft" label="Suggestion" />} <Badge status={a.status} /> <span className="muted small">{fmtDateTime(a.createdAt)}</span></div>
              <p className="att-why">{a.summary}</p>
              {a.patientId && <p className="small"><Link href={`/patients/${a.patientId}`}>{a.patientName}</Link>{a.callId && <> · <Link href={`/calls/${a.callId}`}>Open call</Link></>}</p>}
              {a.status !== "pending" && <p className="muted small">{a.decidedBy ? `${a.status === "rejected" ? "Rejected" : "Approved"} by ${a.decidedBy} ${fmtDateTime(a.decidedAt)}` : ""}{a.note ? ` · ${a.note}` : ""}{a.failure ? ` · Failed: ${a.failure}` : ""}</p>}
              {a.status === "pending" && canDecide && (
                <ActionForm action={decideAction} className="att-ops">
                  <input type="hidden" name="id" value={a.id} />
                  {a.action === "reschedule_appointment" && (
                    <div className="row2" style={{ width: "100%" }}>
                      <Input label="New date" name="date" type="date" /><Input label="New time" name="time" type="time" />
                    </div>
                  )}
                  <input name="note" className="note" placeholder="Note (optional)" aria-label="Note" />
                  <Submit name="decision" value="approve" pending="Working…">{a.mode === "suggest" ? "Do it" : "Approve"}</Submit>
                  <Submit variant="danger" name="decision" value="reject" pending="…">Reject</Submit>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
