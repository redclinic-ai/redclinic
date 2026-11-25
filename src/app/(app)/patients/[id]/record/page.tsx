import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getPatient } from "@/lib/patients/service";
import { patientRecord } from "@/lib/records/service";
import { Badge, Empty, Flash, fmtDate, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { addItemAction, itemStatusAction, startVisitAction } from "../../records-actions";

export const metadata = { title: "Medical record · RedClinic" };
type Src = { source: string; documentId: string | null; documentName: string | null; visitId: string | null; evidence: string | null; by: string | null; at: Date };

function Source({ s, patientId }: { s: Src; patientId: string }) {
  return (
    <span className="muted small">
      {s.source === "document" && s.documentId ? <>from <Link href={`/patients/${patientId}/documents/${s.documentId}`}>{s.documentName}</Link></>
        : s.source === "visit" && s.visitId ? <>from <Link href={`/visits/${s.visitId}`}>a visit</Link></> : "added by hand"}
      {s.by ? ` · ${s.by}` : ""} · {fmtDate(s.at)}
      {s.evidence && <span title={s.evidence}> · “{s.evidence.replace(/^Page \d+, line \d+: /, "").slice(0, 60)}”</span>}
    </span>
  );
}

function StatusButtons({ kind, id, options }: { kind: string; id: string; options: [string, string][] }) {
  return (
    <ActionForm action={itemStatusAction} className="inline-form">
      <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
      {options.map(([v, l]) => <Submit key={v} variant="ghost" name="status" value={v}>{l}</Submit>)}
    </ActionForm>
  );
}

export default async function RecordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_patient_history");
  const { id } = await params;
  const { ok } = await searchParams;
  const [pr, rr] = await Promise.all([getPatient(user, id), patientRecord(user, id)]);
  if (!pr.ok || !rr.ok) notFound();
  const p = pr.value, r = rr.value;
  const write = caps.has("write_clinical");
  const hid = <input type="hidden" name="patientId" value={id} />;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={`${p.name} · medical record`} back={{ href: `/patients/${id}`, label: p.name }} subtitle={<><strong>{p.code}</strong>{p.ageYears != null ? ` · ${p.ageYears} yrs` : ""}{p.gender ? ` · ${p.gender}` : ""}</>}
        actions={write ? <ActionForm action={startVisitAction}>{hid}<Submit>Start a visit note</Submit></ActionForm> : undefined} />
      {r.allergies.length > 0 && (
        <div className="alert alert-error" role="note"><strong>Allergies:</strong> {r.allergies.map((a) => a.reaction ? `${a.substance} (${a.reaction})` : a.substance).join(", ")}</div>
      )}
      <div className="grid2">
        <section className="card">
          <h2 className="h2">Conditions</h2>
          {r.conditions.length === 0 ? <p className="muted">None recorded.</p> : (
            <ul className="mini-list">{r.conditions.map((x) => (
              <li key={x.id}><strong>{x.name}</strong> {x.status === "resolved" && <Badge status="completed" label="Resolved" />}{x.since ? ` · since ${x.since}` : ""}
                <div><Source s={x} patientId={id} /></div>
                {write && <StatusButtons kind="condition" id={x.id} options={x.status === "active" ? [["resolved", "Mark resolved"], ["entered_in_error", "Entered in error"]] : [["active", "Active again"]]} />}
              </li>))}</ul>
          )}
          {write && (
            <details><summary>Add a condition</summary>
              <ActionForm action={addItemAction}>{hid}<input type="hidden" name="kind" value="condition" />
                <div className="row2"><Input label="Condition" name="name" required /><Input label="Since" name="since" required={false} placeholder="e.g. 2019" /></div>
                <Submit>Add</Submit></ActionForm></details>
          )}
        </section>
        <section className="card">
          <h2 className="h2">Allergies</h2>
          {r.allergies.length === 0 ? <p className="muted">None recorded. Ask the patient.</p> : (
            <ul className="mini-list">{r.allergies.map((x) => (
              <li key={x.id}><strong>{x.substance}</strong>{x.reaction ? ` · ${x.reaction}` : ""}{x.severity !== "unknown" ? ` · ${x.severity}` : ""}
                <div><Source s={x} patientId={id} /></div>
                {write && <StatusButtons kind="allergy" id={x.id} options={[["entered_in_error", "Entered in error"]]} />}
              </li>))}</ul>
          )}
          {write && (
            <details><summary>Add an allergy</summary>
              <ActionForm action={addItemAction}>{hid}<input type="hidden" name="kind" value="allergy" />
                <div className="row3"><Input label="Allergic to" name="substance" required /><Input label="Reaction" name="reaction" required={false} />
                  <Select label="Severity" name="severity" defaultValue="unknown" options={[["unknown", "Not known"], ["mild", "Mild"], ["moderate", "Moderate"], ["severe", "Severe"]]} /></div>
                <Submit>Add</Submit></ActionForm></details>
          )}
        </section>
      </div>
      <section className="card">
        <h2 className="h2">Medicines</h2>
        {r.medications.length === 0 ? <p className="muted">None recorded.</p> : (
          <ul className="mini-list">{r.medications.map((m) => (
            <li key={m.id}><strong>{m.name}</strong> {[m.strength, m.dose, m.frequency, m.duration, m.instructions].filter(Boolean).join(" · ")}
              {m.status !== "active" && <> <Badge status="completed" label={m.status === "stopped" ? "Stopped" : "Course done"} /></>}
              <div><Source s={m} patientId={id} />{m.startDate ? ` · from ${fmtDate(m.startDate)}` : ""}</div>
              {write && m.status === "active" && <StatusButtons kind="medication" id={m.id} options={[["completed", "Course done"], ["stopped", "Stopped"], ["entered_in_error", "Entered in error"]]} />}
            </li>))}</ul>
        )}
        {write && (
          <details><summary>Add a medicine the patient takes</summary>
            <ActionForm action={addItemAction}>{hid}<input type="hidden" name="kind" value="medication" />
              <div className="row3"><Input label="Medicine" name="name" required /><Input label="Strength" name="strength" required={false} placeholder="500 mg" /><Input label="How often" name="frequency" required={false} placeholder="1-0-1" /></div>
              <Submit>Add</Submit></ActionForm></details>
        )}
      </section>
      <section className="card">
        <h2 className="h2">Test results</h2>
        {r.labs.length === 0 ? <p className="muted">None recorded. Read a lab report from the patient's documents, or add a value.</p> : (
          <div className="scroll"><table className="table">
            <thead><tr><th>Test</th><th>Latest</th><th>Earlier</th></tr></thead>
            <tbody>{r.labs.map((g) => (
              <tr key={g.testName}>
                <td>{g.testName}{g.rows[0].range ? <div className="muted small">normal {g.rows[0].range}</div> : null}</td>
                <td><strong>{g.rows[0].value}</strong> {g.rows[0].unit} {g.rows[0].flag && g.rows[0].flag !== "normal" && <Badge status="failed" label={g.rows[0].flag} />}
                  <div><Source s={g.rows[0].source} patientId={id} />{g.rows[0].takenOn ? ` · taken ${fmtDate(g.rows[0].takenOn)}` : ""}</div></td>
                <td className="small">{g.rows.slice(1, 5).map((x) => `${x.value}${x.takenOn ? ` (${fmtDate(x.takenOn)})` : ""}`).join(", ") || "—"}</td>
              </tr>))}</tbody></table></div>
        )}
        {write && (
          <details><summary>Add a test value</summary>
            <ActionForm action={addItemAction}>{hid}<input type="hidden" name="kind" value="lab" />
              <div className="row3"><Input label="Test" name="testName" required /><Input label="Value" name="value" required /><Input label="Unit" name="unit" required={false} /></div>
              <div className="row2"><Input label="Normal range" name="range" required={false} placeholder="70-100" /><Input label="Date taken" name="takenOn" type="date" required={false} /></div>
              <Submit>Add</Submit></ActionForm></details>
        )}
      </section>
      <section className="card">
        <h2 className="h2">Visits</h2>
        {r.visits.length === 0 ? <Empty title="No visit notes yet" /> : (
          <ul className="mini-list">{r.visits.map((v) => (
            <li key={v.id}><Link href={`/visits/${v.id}`}>{fmtDate(v.date)}</Link> · {v.doctor ?? "—"} {v.online && <Badge status="scheduled" label="Online" />} {v.status === "draft" && <Badge status="pending" label="Draft" />}
              <div className="small">{v.diagnosis || v.complaint || ""}</div></li>))}</ul>
        )}
      </section>
    </>
  );
}
