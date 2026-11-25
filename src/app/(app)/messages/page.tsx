import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listConversations } from "@/lib/whatsapp/service";
import { Empty, fmtDateTime, PageHeader, Simulated } from "@/components/ui";

export const metadata = { title: "Messages · RedClinic" };

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "view_patients");
  const { open } = await searchParams;
  const r = await listConversations(user, { unhandledOnly: open === "1" });
  if (!r.ok) return <p>{r.error}</p>;
  const waiting = r.value.filter((x) => x.unhandled > 0).length;
  return (
    <>
      <PageHeader title="WhatsApp messages" subtitle={waiting ? `${waiting} conversation${waiting > 1 ? "s" : ""} waiting for a reply.` : "Nothing waiting."} />
      <nav className="subnav" aria-label="Filter">
        <Link href="/messages" aria-current={open !== "1" ? "page" : undefined}>All</Link>
        <Link href="/messages?open=1" aria-current={open === "1" ? "page" : undefined}>Waiting ({waiting})</Link>
      </nav>
      {r.value.length === 0 ? <Empty title="No messages yet">Messages appear here once WhatsApp is connected in Settings and patients have agreed to receive them.</Empty> : (
        <ul className="list">
          {r.value.map((x) => (
            <li key={x.patientId} className={`list-item${x.unhandled ? " is-urgent" : ""}`}>
              <Link href={`/messages/${x.patientId}`}><strong>{x.name}</strong></Link> <span className="muted small">{x.code}</span> {x.simulated && <Simulated />}
              {x.unhandled > 0 && <span className="badge badge-failed">{x.unhandled} new</span>}
              <p className="att-why">{x.direction === "in" ? "" : "You: "}{x.last.slice(0, 140)}</p>
              <p className="muted small">{fmtDateTime(x.at)}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
