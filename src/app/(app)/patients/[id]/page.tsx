import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf } from "@/lib/nav";
import { consentHistory, CONSENT_METHODS, duplicatesOf, getPatient, patientTimeline } from "@/lib/patients/service";
import { listDocuments } from "@/lib/documents/service";
import { currentConsentWordings } from "@/lib/clinic/service";
import { Badge, Empty, Flash, fmtDate, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Select, TextArea } from "@/components/form";
import { clinicalAction, consentAction, mergeAction, uploadAction } from "../actions";

export const metadata = { title: "Patient · RedClinic" };
const METHOD: Record<string, string> = { in_person: "In person", signed_form: "Signed form", verbal: "Verbally (phone)", uploaded_form: "Uploaded form", bulk_import_confirmed: "Confirmed at import" };
const DOC_TYPES: [string, string][] = [["prescription", "Prescription"], ["report", "Report"], ["image", "X-ray or photo"], ["pdf", "Other PDF"], ["note", "Written note (no file)"], ["other", "Other"]];

export default async function PatientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { ok } = await searchParams;
  const caps = await capabilitiesOf(user);
  const pr = await getPatient(user, id);
  if (!pr.ok) notFound();
  const p = pr.value;
  if (p.mergedInto) {
    return <Empty title="This record was merged"><Link href={`/patients/${p.mergedInto}`}>Open the patient it was merged into</Link></Empty>;
  }
  const [docs, timeline, consent, wordings, dups] = await Promise.all([
    caps.has("view_documents") ? listDocuments(user, id) : Promise.resolve([]),
    patientTimeline(user, id),
    consentHistory(user, id),
    currentConsentWordings(user),
    caps.has("merge_patients") ? duplicatesOf(user, id) : Promise.resolve({ ok: true as const, value: [] }),
  ]);
  const enWording = wordings.ok ? wordings.value.find((w) => w.language === "en")!.wording : "";
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={p.name} back={{ href: "/patients", label: "Patients" }}
        subtitle={<><strong>{p.code}</strong>{[p.phone, p.ageYears != null ? `${p.ageYears} yrs` : null, p.gender].filter(Boolean).map((x) => ` · ${x}`)}</>}
        actions={<>
          {caps.has("edit_patient") && <Link className="btn btn-ghost" href={`/patients/${id}/edit`}>Edit</Link>}
          {caps.has("manage_appointments") && <Link className="btn btn-primary" href={`/appointments/new?patient=${id}`}>Book appointment</Link>}
        </>} />

      <div className="grid2">
        <section className="card" aria-labelledby="h-about">
          <h2 className="h2" id="h-about">About</h2>
          <dl className="facts">
            <dt>Next visit</dt><dd>{p.nextVisit ? fmtDateTime(p.nextVisit) : "None booked"}</dd>
            <dt>Last visit</dt><dd>{p.lastVisit ? fmtDate(p.lastVisit) : "—"}</dd>
            <dt>Usual doctor</dt><dd>{p.assignedDoctor ?? "—"}</dd>
            <dt>First came for</dt><dd>{p.firstProblem ?? "—"}</dd>
            {p.email && <><dt>Email</dt><dd>{p.email}</dd></>}
            {p.address && <><dt>Address</dt><dd>{p.address}</dd></>}
            <dt>Registered</dt><dd>{fmtDate(p.registeredAt)}</dd>
          </dl>
        </section>

        <section className="card" id="consent" aria-labelledby="h-consent">
          <h2 className="h2" id="h-consent">Consent <Badge status={p.consentStatus} /></h2>
          {p.consentStatus === "withdrawn" && <p className="small">Automatic calls and reminders are stopped for this patient.</p>}
          {caps.has("record_consent") && (
            <ActionForm action={consentAction}>
              <input type="hidden" name="id" value={id} />
              <details className="more-fields">
                <summary>Read the consent wording</summary>
                <p className="small">{enWording}</p>
                <p className="muted small">Hindi wording is in Settings → Consent wording.</p>
              </details>
              <div className="row2">
                <Select label="Patient's answer" name="status" required defaultValue={p.consentStatus === "given" ? "withdrawn" : "given"} options={[["given", "Agrees"], ["withdrawn", "Does not agree / withdraws"]]} />
                <Select label="How" name="method" required defaultValue="in_person" options={CONSENT_METHODS.map((m) => [m, METHOD[m]])} />
              </div>
              <Select label="Wording read in" name="language" required defaultValue="en" options={[["en", "English"], ["hi", "Hindi"]]} />
              <Submit>Record</Submit>
            </ActionForm>
          )}
          {consent.ok && consent.value.length > 0 && (
            <ul className="mini-list">
              {consent.value.map((c, i) => <li key={i}>{c.status === "given" ? "Agreed" : "Withdrew"} · {METHOD[c.method]} · {fmtDateTime(c.recordedAt)}{c.recordedBy ? ` · ${c.recordedBy}` : ""}</li>)}
            </ul>
          )}
        </section>
      </div>

      {p.clinical && (
        <section className="card" aria-labelledby="h-med">
          <h2 className="h2" id="h-med">Medical history</h2>
          {caps.has("edit_patient") ? (
            <ActionForm action={clinicalAction}>
              <input type="hidden" name="id" value={id} />
              <TextArea label="Allergies" name="allergies" defaultValue={p.clinical.allergies} rows={2} />
              <TextArea label="Medical history" name="medicalHistory" defaultValue={p.clinical.medicalHistory} rows={3} hint="Conditions, ongoing medicines, past procedures." />
              <TextArea label="Doctor's notes" name="notes" defaultValue={p.clinical.notes} rows={3} />
              <Submit>Save medical history</Submit>
            </ActionForm>
          ) : (
            <dl className="facts">
              <dt>Allergies</dt><dd className="pre">{p.clinical.allergies || "None recorded"}</dd>
              <dt>History</dt><dd className="pre">{p.clinical.medicalHistory || "—"}</dd>
              <dt>Notes</dt><dd className="pre">{p.clinical.notes || "—"}</dd>
            </dl>
          )}
        </section>
      )}

      {(caps.has("view_documents") || caps.has("upload_document")) && (
        <section className="card" id="documents" aria-labelledby="h-docs">
          <h2 className="h2" id="h-docs">Documents</h2>
          {caps.has("upload_document") && (
            <ActionForm action={uploadAction} className="upload">
              <input type="hidden" name="id" value={id} />
              <div className="row2">
                <Select label="Type" name="docType" required defaultValue="prescription" options={DOC_TYPES} />
                <div className="field">
                  <label htmlFor="file">File (PDF, JPG or PNG, up to 15 MB)</label>
                  <input id="file" name="file" type="file" accept="application/pdf,image/jpeg,image/png" capture="environment" />
                </div>
              </div>
              <TextArea label="Description" name="description" rows={2} hint="For a written note, type it here." />
              <Submit pending="Uploading…">Add document</Submit>
            </ActionForm>
          )}
          {caps.has("view_documents") ? (
            docs.length === 0 ? <p className="muted">No documents yet.</p> : (
              <ul className="mini-list">
                {docs.map((d) => (
                  <li key={d.id}>
                    {d.hasFile ? <a href={`/api/documents/${d.id}/open`} target="_blank" rel="noopener">{d.originalFilename ?? d.docType}</a> : <strong>Note</strong>}
                    <span className="muted small"> · {d.docType} · {fmtDate(d.uploadedAt)}{d.uploadedBy ? ` · ${d.uploadedBy}` : ""}</span>
                    {d.description && <div className="small pre">{d.description}</div>}
                  </li>
                ))}
              </ul>
            )
          ) : <p className="muted small">You can add documents. Only staff allowed to open documents can see them.</p>}
        </section>
      )}

      <section className="card" aria-labelledby="h-hist">
        <h2 className="h2" id="h-hist">History</h2>
        {timeline.ok && timeline.value.length > 0 ? (
          <ol className="timeline">
            {timeline.value.map((t) => (
              <li key={t.kind + t.id}>
                <span className="muted small">{fmtDateTime(t.at)}</span>
                {t.kind === "appointment" ? <Link href={`/appointments/${t.id}`}>{t.title}</Link> : t.kind === "call" ? <Link href={`/calls/${t.id}`}>{t.title}</Link> : <span>{t.title}</span>}
                {t.detail && <span className="muted small"> · {t.detail}</span>}
              </li>
            ))}
          </ol>
        ) : <p className="muted">Appointments, calls and documents will show here.</p>}
      </section>

      {dups.ok && dups.value.length > 0 && (
        <section className="card" aria-labelledby="h-dup">
          <h2 className="h2" id="h-dup">Possible duplicate records</h2>
          {dups.value.map((d) => (
            <ActionForm key={d.patientId} action={mergeAction} className="list-item">
              <input type="hidden" name="keep" value={id} />
              <input type="hidden" name="merge" value={d.patientId} />
              <p><Link href={`/patients/${d.patientId}`}>{d.name} ({d.code})</Link> <span className="muted small">· {d.reason}</span></p>
              <label className="check"><input type="checkbox" name="sure" /> <span>Same person: move their appointments, calls and documents into {p.code}</span></label>
              <Submit variant="ghost" pending="Merging…">Merge into this record</Submit>
            </ActionForm>
          ))}
        </section>
      )}
    </>
  );
}
