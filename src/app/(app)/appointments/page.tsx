import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf, requirePageCap } from "@/lib/nav";
import { clinicToday, listAppointments } from "@/lib/appointments/service";
import { listDoctors } from "@/lib/patients/service";
import { addDays, Badge, Empty, fmtDay, fmtLocalTime, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

export const metadata = { title: "Appointments · RedClinic" };

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<{ date?: string; doctor?: string; cancelled?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_appointments", "view_patients");
  const caps = await capabilitiesOf(user);
  const sp = await searchParams;
  const today = (await clinicToday(user));
  const todayStr = today.ok ? today.value : new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date! : todayStr;
  const [list, doctors] = await Promise.all([
    listAppointments(user, { from: date, to: date, doctorId: sp.doctor || undefined, includeCancelled: sp.cancelled === "1" }),
    listDoctors(user),
  ]);
  const appts = list.ok ? list.value : [];
  const q = (d: string) => `/appointments?date=${d}${sp.doctor ? `&doctor=${sp.doctor}` : ""}${sp.cancelled ? "&cancelled=1" : ""}`;
  const week = Array.from({ length: 7 }, (_, i) => addDays(date, i - 3));
  const counts = { total: appts.filter((a) => a.status !== "cancelled").length, confirmed: appts.filter((a) => a.status === "confirmed").length };
  return (
    <>
      <PageHeader title="Appointments" subtitle={`${fmtDay(date)}${date === todayStr ? " · Today" : ""} · ${counts.total} booked, ${counts.confirmed} confirmed`}
        actions={caps.has("manage_appointments") && <>
          <Link className="btn btn-ghost" href="/appointments/new?walkin=1">Walk-in</Link>
          <Link className="btn btn-primary" href={`/appointments/new?date=${date}`}><Icon name="plus" size={18} /> Book</Link>
        </>} />
      <nav className="daystrip" aria-label="Choose day">
        <Link href={q(addDays(date, -7))} aria-label="Previous week"><Icon name="left" /></Link>
        {week.map((d) => (
          <Link key={d} href={q(d)} aria-current={d === date ? "date" : undefined} className={d === todayStr ? "is-today" : undefined}>
            <span className="small">{fmtDay(d).split(" ")[0].replace(",", "")}</span><strong>{Number(d.slice(8))}</strong>
          </Link>
        ))}
        <Link href={q(addDays(date, 7))} aria-label="Next week"><Icon name="right" /></Link>
      </nav>
      <form className="filters">
        <input type="hidden" name="date" value={date} />
        <label className="sr-only" htmlFor="doctor">Doctor</label>
        <select id="doctor" name="doctor" defaultValue={sp.doctor ?? ""}>
          <option value="">All doctors</option>
          {doctors.ok && doctors.value.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className="check"><input type="checkbox" name="cancelled" value="1" defaultChecked={sp.cancelled === "1"} /> <span>Show cancelled</span></label>
        <input type="date" name="date" defaultValue={date} aria-label="Go to date" />
        <button className="btn btn-ghost btn-sm" type="submit">Show</button>
        {date !== todayStr && <Link href={`/appointments${sp.doctor ? `?doctor=${sp.doctor}` : ""}`} className="small">Back to today</Link>}
      </form>
      {appts.length === 0 ? <Empty title="No appointments on this day" /> : (
        <ul className="list">
          {appts.map((a) => (
            <li key={a.id}>
              <Link href={`/appointments/${a.id}`} className="list-item appt-row link-row">
                <div className="appt-time"><strong>{fmtLocalTime(a.localTime)}</strong><span className="muted small">{a.durationMinutes} min</span></div>
                <div className="appt-main">
                  <span className="strong">{a.patientName}</span> <span className="muted small">{a.patientCode}</span>
                  <div className="muted small">{[a.serviceName, a.reason, a.doctorName && `Dr ${a.doctorName.replace(/^Dr\.?\s*/i, "")}`, a.bookedVia === "walk_in" ? "Walk-in" : a.bookedVia === "nepa" ? "Booked by AI receptionist" : null].filter(Boolean).join(" · ")}</div>
                </div>
                <Badge status={a.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
