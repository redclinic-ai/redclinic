import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { listClinics } from "@/lib/admin/service";
import { Badge, Empty, fmtDate, fmtDateTime, PageHeader } from "@/components/ui";

export const metadata = { title: "Clinics · RedClinic admin" };

export default async function AdminClinics({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const { q } = await searchParams;
  const r = await listClinics(user, 30);
  if (!r.ok) return <p>{r.error}</p>;
  const clinics = r.value.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || (c.city ?? "").toLowerCase().includes(q.toLowerCase()));
  const totals = r.value.reduce((t, c) => ({ calls: t.calls + c.calls, appts: t.appts + c.appointments, minutes: t.minutes + c.minutes }), { calls: 0, appts: 0, minutes: 0 });
  return (
    <>
      <PageHeader title="Clinics" subtitle={`${r.value.length} clinics · last 30 days: ${totals.calls} real calls, ${totals.appts} appointments booked, ${totals.minutes} voice minutes`} />
      <form className="searchbar" role="search"><input type="search" name="q" defaultValue={q} placeholder="Clinic name or city" aria-label="Search clinics" /><button className="btn btn-ghost">Search</button></form>
      {clinics.length === 0 ? <Empty title="No clinics yet" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Clinic</th><th>Plan</th><th className="num">Calls</th><th className="num">Appointments</th><th className="num">Minutes</th><th className="num">Staff</th><th className="num">Patients</th><th>Last call</th><th>Status</th></tr></thead>
            <tbody>
              {clinics.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/admin/clinics/${c.id}`} className="strong">{c.name}</Link><div className="muted small">{c.type}{c.city ? ` · ${c.city}` : ""} · since {fmtDate(c.createdAt)}</div></td>
                  <td>{c.plan ?? "—"}{c.subStatus && <div className="small"><Badge status={c.subStatus === "active" ? "active" : c.subStatus === "trialing" ? "draft" : "pending"} label={c.subStatus} /></div>}</td>
                  <td className="num">{c.calls}</td><td className="num">{c.appointments}</td><td className="num">{c.minutes}</td><td className="num">{c.staff}</td><td className="num">{c.patients}</td>
                  <td className="small">{c.lastCall ? fmtDateTime(c.lastCall) : "—"}</td>
                  <td><Badge status={c.status} label={c.status === "suspended" ? "Paused" : "Active"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Counts exclude test calls. Minutes are rounded up per period.</p>
    </>
  );
}
