import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getVisit } from "@/lib/records/service";
import { Badge, Flash, fmtDate, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, TextArea } from "@/components/form";
import { addendumAction, visitMedAction, saveVisitAction, signVisitAction } from "../actions";

export const metadata = { title: "Visit note · RedClinic" };
const VITALS: [string, string, string][] = [["bp_systolic", "BP systolic", "mmHg"], ["bp_diastolic", "BP diastolic", "mmHg"], ["pulse", "Pulse", "/min"], ["temperature_c", "Temperature", "°C"], ["spo2", "SpO₂", "%"], ["weight_kg", "Weight", "kg"], ["height_cm", "Height", "cm"]];

export default async function VisitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_patient_history");
  const { id } = await params;
  const { ok } = await searchParams;
  const r = await getVisit(user, id);
  if (!r.ok) notFound();
  const v = r.value;
  const edit = caps.has("write_clinical") && v.status === "draft";
  const hid = <input type="hidden" name="id" value={id} />;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={`Visit · ${fmtDate(v.date)}`} back={{ href: `/patients/${v.patientId}/record`, label: v.patientName }}
        subtitle={<>{v.patientName} · {v.patientCode}{v.age != null ? ` · ${v.age} yrs` : ""} · {v.doctor ?? "—"}{v.online ? " · online" : ""}</>}
        actions={<>{v.status === "signed" ? <Badge status="confirmed" label={`Signed ${fmtDateTime(v.signedAt)}`} /> : <Badge status="pending" label="Draft" />}
          <Link className="btn btn-ghost" href={`/visits/${id}/print`}>Prescription</Link></>} />
      {v.allergies.length > 0 && <div className="alert alert-error" role="note"><strong>Allergies:</strong> {v.allergies.join(", ")}</div>}
      {edit ? (
        <ActionForm action={saveVisitAction} className="card">
          {hid}
          <TextArea label="Complaint" name="chiefComplaint" rows={2} defaultValue={v.chiefComplaint} maxLength={1000} />
          <fieldset><legend>Vitals</legend><div className="row3">
            {VITALS.map(([k, l, u]) => <Input key={k} label={`${l} (${u})`} name={`v_${k}`} type="number" required={false} defaultValue={v.vitals[k] ?? ""} />)}
          </div></fieldset>
          <TextArea label="Findings" name="findings" rows={3} defaultValue={v.findings} maxLength={4000} />
          <TextArea label="Diagnosis" name="diagnosis" rows={2} defaultValue={v.diagnosis} maxLength={1000} hint="One per line. Signing adds them to the patient's conditions." />
          <TextArea label="Advice" name="advice" rows={3} defaultValue={v.advice} maxLength={4000} />
          <Input label="Next visit" name="followUp" defaultValue={v.followUp} required={false} placeholder="e.g. after 1 week for the second sitting" />
          <Submit>Save draft</Submit>
        </ActionForm>
      ) : (
        <section className="card">
          <dl className="kv">
            <dt>Complaint</dt><dd className="pre">{v.chiefComplaint || "—"}</dd>
            <dt>Vitals</dt><dd>{VITALS.filter(([k]) => v.vitals[k] != null).map(([k, l, u]) => `${l} ${v.vitals[k]} ${u}`).join(" · ") || "—"}</dd>
            <dt>Findings</dt><dd className="pre">{v.findings || "—"}</dd>
            <dt>Diagnosis</dt><dd className="pre">{v.diagnosis || "—"}</dd>
            <dt>Advice</dt><dd className="pre">{v.advice || "—"}</dd>
            <dt>Next visit</dt><dd>{v.followUp || "—"}</dd>
          </dl>
          {v.addenda.length > 0 && <><h3 className="h3">Corrections</h3><ul className="mini-list">{v.addenda.map((a, i) => <li key={i}>{fmtDateTime(a.at)} · {a.by}: {a.text}</li>)}</ul></>}
        </section>
      )}
      <section className="card">
        <h2 className="h2">Prescription</h2>
        {v.medications.length === 0 ? <p className="muted">No medicines.</p> : (
          <ol>{v.medications.map((m) => <li key={m.id}><strong>{m.name}</strong> {[m.strength, m.dose, m.frequency, m.duration, m.instructions].filter(Boolean).join(" · ")}</li>)}</ol>
        )}
        {edit && (
          <ActionForm action={visitMedAction}>
            {hid}
            <div className="row3"><Input label="Medicine" name="name" required /><Input label="Strength" name="strength" required={false} placeholder="500 mg" /><Input label="How often" name="frequency" required={false} placeholder="1-0-1" /></div>
            <div className="row3"><Input label="For how long" name="duration" required={false} placeholder="5 days" /><Input label="Instructions" name="instructions" required={false} placeholder="after food" /><Input label="Route" name="route" required={false} placeholder="oral" /></div>
            <Submit>Add medicine</Submit>
          </ActionForm>
        )}
      </section>
      {caps.has("write_clinical") && (v.status === "draft" ? (
        <ActionForm action={signVisitAction} className="card">{hid}
          <p>Signing locks this note. Later changes are added as corrections, with your name and the time.</p>
          <Submit>Sign the note</Submit></ActionForm>
      ) : (
        <ActionForm action={addendumAction} className="card">{hid}
          <TextArea label="Add a correction" name="text" rows={2} maxLength={2000} /><Submit variant="ghost">Add correction</Submit></ActionForm>
      ))}
    </>
  );
}
