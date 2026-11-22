import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { getToday } from "@/lib/today/service";
import { KIND_LABEL } from "@/lib/attention/service";
import { Badge, Empty, fmtDay, fmtLocalTime } from "@/components/ui";

export const metadata = { title: "Today · RedClinic" };

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ welcome?: string; denied?: string }> }) {
  const user = await requireUser();
  if (user.isSuperAdmin) {
    const { redirect } = await import("next/navigation");
    redirect("/admin");
  }
  const { welcome, denied } = await searchParams;
  const r = await getToday(user);
  if (!r.ok) return <p>{r.error}</p>;
  const t = r.value;
  const now = Date.now();
  const upcoming = t.appointments.filter((a) => a.status === "scheduled" || a.status === "confirmed");
  const next = upcoming.find((a) => new Date(a.startsAt).getTime() > now - 15 * 60_000);
  const setupLeft = t.setup.filter((s) => !s.done);
  const done = t.completed;
  return (
    <>
      {denied && <div className="alert alert-error" role="alert">You don't have access to that page. Ask your clinic admin if you need it.</div>}
      {welcome === "dental" && <div className="alert alert-success" role="status">Dental workflows are ready. Review and edit them in Workflows.</div>}
      <div className="page-head"><div><h1>{greeting()}, {user.displayName.split(" ")[0] === "Dr" ? user.displayName : user.displayName.split(" ")[0]}</h1><p className="muted">{fmtDay(t.date)}</p></div></div>

      {setupLeft.length > 0 && (
        <section className="card setup" aria-labelledby="h-setup">
          <h2 className="h2" id="h-setup">Finish setting up · {t.setup.length - setupLeft.length} of {t.setup.length} done</h2>
          <progress max={t.setup.length} value={t.setup.length - setupLeft.length} aria-hidden />
          <ul className="checklist">
            {t.setup.map((s) => (
              <li key={s.key} className={s.done ? "is-done" : undefined}>
                <span className="tick" aria-hidden>{s.done ? "✓" : ""}</span>
                {s.done ? <span>{s.label}</span> : <Link href={s.href}>{s.label}</Link>}
                <span className="sr-only">{s.done ? "(done)" : "(to do)"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="today-grid">
        <section className="card" aria-labelledby="h-appts">
          <h2 className="h2" id="h-appts">{user.role === "doctor" ? "Your patients today" : "Today's appointments"} <span className="muted small">· {upcoming.length} still to come</span></h2>
          {next && (
            <Link href={`/appointments/${next.id}`} className="next-up">
              <span className="small">Next</span>
              <strong>{fmtLocalTime(next.time)} · {next.patient}</strong>
              <span className="small">{[next.service, next.doctor].filter(Boolean).join(" · ")}</span>
            </Link>
          )}
          {t.appointments.length === 0 ? <p className="muted">No appointments today.</p> : (
            <ul className="mini-list">
              {t.appointments.map((a) => (
                <li key={a.id} className="appt-mini">
                  <span className="time">{fmtLocalTime(a.time)}</span>
                  <Link href={`/appointments/${a.id}`}>{a.patient}</Link>
                  <Badge status={a.status} />
                </li>
              ))}
            </ul>
          )}
          <p className="small"><Link href="/appointments">All appointments</Link></p>
        </section>

        <section className="card" aria-labelledby="h-att">
          <h2 className="h2" id="h-att">Needs attention {t.attentionCount > 0 && <span className="count">{t.attentionCount}</span>}</h2>
          {t.attention.length === 0 ? <p className="muted">Nothing needs you right now.</p> : (
            <ul className="mini-list">
              {t.attention.map((i) => (
                <li key={i.id}>
                  {i.urgency === 1 && <Badge status="failed" label="Urgent" />} <strong>{KIND_LABEL[i.kind]}</strong>{i.patient ? ` · ${i.patient}` : ""}
                  <div className="muted small">{i.reason}</div>
                </li>
              ))}
            </ul>
          )}
          {t.attentionCount > 0 && <p className="small"><Link href="/inbox">Open the list</Link></p>}
        </section>

        <section className="card" aria-labelledby="h-done">
          <h2 className="h2" id="h-done">Done by RedClinic today</h2>
          {done.callsIn + done.callsHandled + done.reminders + done.bookedByNepa === 0 ? (
            <Empty title="Nothing yet today">Calls answered, reminders and bookings by your AI receptionist appear here.</Empty>
          ) : (
            <dl className="stats">
              <div><dt>Calls answered by AI</dt><dd>{done.callsHandled}</dd></div>
              <div><dt>Appointments booked by AI</dt><dd>{done.bookedByNepa}</dd></div>
              <div><dt>Reminders and confirmations</dt><dd>{done.reminders}</dd></div>
            </dl>
          )}
        </section>
      </div>
    </>
  );
}
