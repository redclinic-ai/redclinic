import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { getVisit } from "@/lib/records/service";
import { fmtDate } from "@/components/ui";

export const metadata = { title: "Prescription · RedClinic" };

/** A plain page to print or save as PDF from the browser (Ctrl+P). */
export default async function PrintPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "view_patient_history");
  const r = await getVisit(user, (await params).id);
  if (!r.ok) notFound();
  const v = r.value;
  return (
    <article className="rx">
      <header className="rx-head"><div><strong>{v.clinic.name}</strong><div className="small">{[v.clinic.address, v.clinic.phone].filter(Boolean).join(" · ")}</div></div>
        <div className="small">{fmtDate(v.date)}</div></header>
      <p><strong>{v.patientName}</strong> · {v.patientCode}{v.age != null ? ` · ${v.age} yrs` : ""}{v.gender ? ` · ${v.gender}` : ""}</p>
      {v.allergies.length > 0 && <p><strong>Allergies:</strong> {v.allergies.join(", ")}</p>}
      {v.chiefComplaint && <p><strong>Complaint:</strong> {v.chiefComplaint}</p>}
      {v.diagnosis && <p><strong>Diagnosis:</strong> {v.diagnosis}</p>}
      <h2 className="rx-symbol">℞</h2>
      <ol className="rx-list">{v.medications.map((m) => <li key={m.id}><strong>{m.name}</strong> {[m.strength, m.dose, m.frequency, m.duration, m.instructions].filter(Boolean).join(" · ")}</li>)}</ol>
      {v.advice && <p className="pre"><strong>Advice:</strong> {v.advice}</p>}
      {v.followUp && <p><strong>Next visit:</strong> {v.followUp}</p>}
      <footer className="rx-sign"><div>{v.doctor ?? ""}</div><div className="small">{v.status === "signed" ? "Signed in RedClinic" : "Draft — not signed"}</div></footer>
    </article>
  );
}
