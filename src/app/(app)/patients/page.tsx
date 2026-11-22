import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf, requirePageCap } from "@/lib/nav";
import { searchPatients } from "@/lib/patients/service";
import { Badge, Empty, fmtDate, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

export const metadata = { title: "Patients · RedClinic" };

export default async function PatientsPage({ searchParams }: { searchParams: Promise<{ q?: string; consent?: string; page?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "view_patients");
  const caps = await capabilitiesOf(user);
  const { q = "", consent = "", page = "1" } = await searchParams;
  const pageNo = Math.max(1, Number(page) || 1);
  const r = await searchPatients(user, { q, consent, limit: 50, offset: (pageNo - 1) * 50 });
  if (!r.ok) return <p>{r.error}</p>;
  const { patients, total } = r.value;
  return (
    <>
      <PageHeader title="Patients" subtitle={`${total} ${q || consent ? "found" : "in total"}`}
        actions={<>
          {caps.has("import_patients") && <Link className="btn btn-ghost" href="/patients/import">Import</Link>}
          {caps.has("export_data") && <a className="btn btn-ghost" href="/api/patients/export">Export CSV</a>}
          {caps.has("edit_patient") && <Link className="btn btn-primary" href="/patients/new"><Icon name="plus" size={18} /> New patient</Link>}
        </>} />
      <form className="searchbar" role="search">
        <label className="sr-only" htmlFor="q">Search patients</label>
        <Icon name="search" />
        <input id="q" name="q" defaultValue={q} placeholder="Name, mobile number or patient ID" type="search" autoComplete="off" />
        <select name="consent" defaultValue={consent} aria-label="Consent">
          <option value="">Any consent</option><option value="given">Consent given</option>
          <option value="not_recorded">Consent not recorded</option><option value="withdrawn">Consent withdrawn</option>
        </select>
        <button className="btn btn-ghost" type="submit">Search</button>
      </form>
      {patients.length === 0 ? (
        <Empty title={q ? `No patient matches “${q}”` : "No patients yet"}>
          {caps.has("edit_patient") && <Link href={`/patients/new${q ? `?name=${encodeURIComponent(q)}` : ""}`}>Add a new patient</Link>}
        </Empty>
      ) : (
        <ul className="list">
          {patients.map((p) => (
            <li key={p.id}>
              <Link className="list-item list-row link-row" href={`/patients/${p.id}`}>
                <div>
                  <span className="strong">{p.name}</span> <span className="muted small">{p.code}</span>
                  <div className="muted small">{[p.phone, p.ageYears != null ? `${p.ageYears} yrs` : null, p.gender].filter(Boolean).join(" · ") || "No contact details"}</div>
                </div>
                <div className="row-end small">
                  {p.nextVisit ? <span>Next: {fmtDate(p.nextVisit)}</span> : p.lastVisit ? <span className="muted">Last: {fmtDate(p.lastVisit)}</span> : null}
                  {p.consentStatus !== "given" && <Badge status={p.consentStatus} />}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {total > pageNo * 50 && <p><Link href={`/patients?q=${encodeURIComponent(q)}&consent=${consent}&page=${pageNo + 1}`}>Show more</Link></p>}
    </>
  );
}
