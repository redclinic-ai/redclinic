import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listCalls } from "@/lib/calls/service";
import { Badge, Empty, fmtDateTime, PageHeader, Simulated } from "@/components/ui";

export const metadata = { title: "Calls · RedClinic" };

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ dir?: string; status?: string; sim?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_calls");
  const sp = await searchParams;
  const r = await listCalls(user, { direction: sp.dir || undefined, status: sp.status || undefined, includeSimulated: sp.sim === "1" });
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <PageHeader title="Calls" subtitle="Every call NEPA took or made, with what was said and done."
        actions={(caps.has("edit_workflow") || caps.has("view_calls")) && <Link className="btn btn-ghost" href="/calls/test">Make a test call</Link>} />
      <form className="filters">
        <select name="dir" defaultValue={sp.dir ?? ""} aria-label="Direction"><option value="">In and out</option><option value="inbound">Incoming</option><option value="outbound">Outgoing</option></select>
        <select name="status" defaultValue={sp.status ?? ""} aria-label="Status"><option value="">Any result</option><option value="completed">Completed</option><option value="handed_to_staff">Handed to staff</option><option value="missed">Missed</option><option value="failed">Failed</option></select>
        <label className="check"><input type="checkbox" name="sim" value="1" defaultChecked={sp.sim === "1"} /> <span>Include test calls</span></label>
        <button className="btn btn-ghost btn-sm">Show</button>
      </form>
      {r.value.length === 0 ? <Empty title="No calls yet">Calls appear here once your number is forwarded to NEPA. You can try a test call now.</Empty> : (
        <ul className="list">
          {r.value.map((c) => (
            <li key={c.id}>
              <Link href={`/calls/${c.id}`} className="list-item list-row link-row">
                <div>
                  <span className="strong">{c.patientName ?? c.callerNumber ?? "Unknown caller"}</span> <span className="muted small">{c.direction === "inbound" ? "Incoming" : `Outgoing${c.purpose ? ` · ${c.purpose.replace(/_/g, " ")}` : ""}`} · {fmtDateTime(c.startedAt)}{c.durationSeconds ? ` · ${Math.ceil(c.durationSeconds / 60)} min` : ""}</span>
                  {c.summary && <div className="muted small">{c.summary}</div>}
                </div>
                <div className="row-end">{c.isSimulated && <Simulated />}<Badge status={c.status} /></div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
