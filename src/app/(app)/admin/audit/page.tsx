import { requireUser } from "@/lib/auth/session-cookie";
import { auditLog } from "@/lib/admin/service";
import { Empty, fmtDateTime, PageHeader } from "@/components/ui";

export const metadata = { title: "Audit log · RedClinic admin" };

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ clinic?: string; action?: string; sup?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const r = await auditLog(user, { clinicId: sp.clinic || undefined, action: sp.action || undefined, superOnly: sp.sup === "1" });
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every sign-in, change, record view and NEPA action. Entries can't be changed or deleted." />
      <form className="filters">
        {sp.clinic && <input type="hidden" name="clinic" value={sp.clinic} />}
        <input name="action" defaultValue={sp.action} placeholder="Action contains…" aria-label="Action" />
        <label className="check"><input type="checkbox" name="sup" value="1" defaultChecked={sp.sup === "1"} /> <span>RedClinic actions only</span></label>
        <button className="btn btn-ghost btn-sm">Filter</button>
      </form>
      {r.value.length === 0 ? <Empty title="Nothing found" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>When</th><th>Who</th><th>Clinic</th><th>What</th><th>Details</th></tr></thead>
          <tbody>{r.value.map((a) => (
            <tr key={a.id}><td className="small">{fmtDateTime(a.at)}</td><td>{a.actor}{a.isSuper && <span className="badge badge-done">RedClinic</span>}</td><td className="small">{a.clinic ?? "—"}</td>
              <td>{a.action.replace(/_/g, " ")}<div className="muted small">{a.entity} {a.entityId?.slice(0, 8)}</div></td>
              <td className="small mono">{Object.keys(a.detail ?? {}).length ? JSON.stringify(a.detail).slice(0, 120) : ""}</td></tr>
          ))}</tbody>
        </table></div>
      )}
    </>
  );
}
