import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getExtraction } from "@/lib/records/service";
import { Badge, Flash, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { confirmItemsAction, readDocumentAction } from "../../../records-actions";

export const metadata = { title: "Read document · RedClinic" };
const KIND: Record<string, string> = { medication: "Medicine", condition: "Condition", allergy: "Allergy", lab: "Test result" };
const FIELD: Record<string, string> = { name: "Name", strength: "Strength", frequency: "How often", duration: "For", instructions: "Instructions", route: "Route",
  substance: "Allergic to", reaction: "Reaction", test_name: "Test", value: "Value", unit: "Unit", reference_range: "Normal range", flag: "Flag" };

export default async function ReadDocumentPage({ params, searchParams }: { params: Promise<{ id: string; docId: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_patient_history");
  const { id, docId } = await params;
  const { ok } = await searchParams;
  const r = await getExtraction(user, docId);
  if (!r.ok) notFound();
  const x = r.value;
  const canRead = caps.has("write_clinical") || caps.has("upload_document");
  const hid = <><input type="hidden" name="patientId" value={id} /><input type="hidden" name="documentId" value={docId} /></>;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={x ? `Read: ${x.fileName}` : "Read document"} back={{ href: `/patients/${id}#documents`, label: "Patient" }}
        subtitle={<><a href={`/api/documents/${docId}/open`} target="_blank" rel="noopener">Open the original</a>. Nothing goes into the record until a doctor ticks it.</>} />
      {!x || x.status === "failed" ? (
        <section className="card">
          {x?.error && <p className="alert alert-error">{x.error}</p>}
          <p>RedClinic reads the text of the document on its own server (PDF text, or OCR for photos in English, Hindi and Kannada) and suggests medicines, conditions, allergies and test results for you to check.</p>
          {canRead ? <ActionForm action={readDocumentAction}>{hid}<Submit pending="Reading… (up to a minute for a photo)">{x ? "Try again" : "Read this document"}</Submit></ActionForm>
            : <p className="muted">Ask a doctor to read this document.</p>}
        </section>
      ) : (
        <>
          <p className="muted small">Read by {x.method === "ocr" ? `OCR${x.confidence !== null ? ` (confidence ${x.confidence}%)` : ""}` : x.method === "pdf_text" ? "the PDF's text" : x.method}.
            {x.method === "ocr" && x.confidence !== null && x.confidence < 70 ? " The photo was hard to read: check every value against the original." : ""}</p>
          {x.status === "ready" ? (
            caps.has("write_clinical") ? (
              <ActionForm action={confirmItemsAction} className="card">
                {hid}
                <h2 className="h2">Suggestions ({x.items.length})</h2>
                {x.items.length === 0 && <p className="muted">Nothing recognisable was found. You can still add items by hand in the record.</p>}
                <ul className="list">{x.items.map((it) => (
                  <li key={it.key} className="list-item">
                    <label className="check"><input type="checkbox" name="take" value={it.key} defaultChecked={it.kind !== "lab" || !!it.fields.unit} />
                      <span><strong>{KIND[it.kind]}</strong> <span className="muted small">· page {it.evidence.page}, line {it.evidence.line}: “{it.evidence.text}”</span></span></label>
                    <div className="row3">
                      {Object.entries(it.fields).filter(([k]) => !k.startsWith("_")).map(([k, v]) => (
                        <div className="field" key={k}><label htmlFor={`${it.key}.${k}`}>{FIELD[k] ?? k}</label><input id={`${it.key}.${k}`} name={`${it.key}.${k}`} defaultValue={v} /></div>
                      ))}
                    </div>
                  </li>
                ))}</ul>
                <div className="form-actions">
                  <Submit>Add ticked items to the record</Submit>
                  <Submit variant="ghost" name="dismiss" value="1">Nothing to add</Submit>
                </div>
              </ActionForm>
            ) : <p className="card">A doctor needs to check these {x.items.length} suggestions before they go into the record.</p>
          ) : <p className="card"><Badge status={x.status === "confirmed" ? "confirmed" : "cancelled"} label={x.status === "confirmed" ? "Reviewed" : "Nothing added"} /> {x.reviewer ? `by ${x.reviewer}` : ""} {x.reviewedAt ? fmtDateTime(x.reviewedAt) : ""}. <Link href={`/patients/${id}/record`}>Open the record</Link></p>}
          <details className="card"><summary>Text read from the document</summary><pre className="small pre">{x.text}</pre></details>
        </>
      )}
    </>
  );
}
