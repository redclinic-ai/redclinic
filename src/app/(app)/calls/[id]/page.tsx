import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf } from "@/lib/nav";
import { getCall } from "@/lib/calls/service";
import { Badge, fmtDateTime, PageHeader, Simulated } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { callBackAction, correctAction, retryAction } from "../actions";

export const metadata = { title: "Call · RedClinic" };

export default async function CallPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ test?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { test } = await searchParams;
  const caps = await capabilitiesOf(user);
  const r = await getCall(user, id);
  if (!r.ok) notFound();
  const c = r.value;
  const mmss = (ms: number | null) => (ms == null ? "" : `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`);
  return (
    <>
      {test && <div className="alert alert-sim">Test call finished. This is the record staff will see for real calls. Test calls never count in Results.</div>}
      <PageHeader title={c.patientName ?? c.callerNumber ?? "Unknown caller"} back={{ href: "/calls", label: "Calls" }}
        subtitle={<>{c.direction === "inbound" ? "Incoming" : "Outgoing"} · {fmtDateTime(c.startedAt)}{c.durationSeconds ? ` · ${Math.ceil(c.durationSeconds / 60)} min` : ""}{c.callerNumber && c.patientName ? ` · ${c.callerNumber}` : ""}</>}
        actions={<>{c.isSimulated && <Simulated />}<Badge status={c.status} /></>} />
      <div className="grid2">
        <section className="card" aria-label="Summary">
          <h2 className="h2">What happened</h2>
          <p>{c.summary ?? "No summary."}</p>
          {c.followUp && <p className="alert alert-error">{c.followUp}</p>}
          <dl className="facts small">
            {c.patientId && <><dt>Patient</dt><dd><Link href={`/patients/${c.patientId}`}>{c.patientName} ({c.patientCode})</Link></dd></>}
            <dt>Handled by</dt><dd>{c.handedToStaff ? "NEPA, then staff" : c.handledByNepa ? "NEPA" : "Nobody (missed)"}</dd>
            {c.language && <><dt>Language</dt><dd>{({ en: "English", hi: "Hindi", kn: "Kannada" } as Record<string, string>)[c.language] ?? c.language}</dd></>}
            <dt>Recording</dt><dd>{c.recording.status === "stored" ? `Stored (${c.recording.format})` : c.isSimulated ? "None (test call)" : c.recording.status.replace(/_/g, " ")}</dd>
            <dt>Rules used</dt><dd>{(() => { const v = c.configVersions as { clinicConfig?: number | null; agentConfig?: number | null; policies?: object }; return `Clinic ${v.clinicConfig ? `v${v.clinicConfig}` : "defaults"}, agent ${v.agentConfig ? `v${v.agentConfig}` : "defaults"}, ${Object.keys(v.policies ?? {}).length} RedClinic policies`; })()}</dd>
          </dl>
          {c.actions.length > 0 && <><h3 className="h3">Actions</h3><ul className="mini-list">{c.actions.map((a: any, i: number) => <li key={i}>{a.tool.replace(/_/g, " ")}: <strong>{a.outcome.status.replace(/_/g, " ")}</strong></li>)}</ul></>}
          {c.approvals.length > 0 && <p className="small"><Link href="/approvals">{c.approvals.length} approval request{c.approvals.length > 1 ? "s" : ""}</Link></p>}
          {c.status === "missed" && caps.has("view_calls") && (
            <ActionForm action={callBackAction}><input type="hidden" name="callId" value={c.id} /><Submit pending="…">Have NEPA call back</Submit></ActionForm>
          )}
        </section>
        <section className="card" aria-label="Transcript">
          <h2 className="h2">Transcript {c.transcription.status !== "completed" && <Badge status={c.transcription.status === "failed" ? "failed" : "pending"} label={c.transcription.status} />}</h2>
          {c.transcript === null ? <p className="muted">You don't have permission to read transcripts.</p> : (
            <>
              {c.transcription.status === "failed" && (
                <ActionForm action={retryAction}>
                  <p className="small">Transcription failed ({c.transcription.error}). Tried {c.transcription.attempts} time{c.transcription.attempts === 1 ? "" : "s"}. The recording is kept.</p>
                  <input type="hidden" name="callId" value={c.id} /><Submit variant="ghost" pending="Trying…">Try again</Submit>
                </ActionForm>
              )}
              {c.transcript.length === 0 ? <p className="muted">No transcript. Nothing is ever made up.</p> : (
                <ol className="transcript">
                  {c.transcript.map((t) => (
                    <li key={t.id} className={`seg ${t.speaker}`}>
                      <span className="seg-who">{t.speaker === "nepa" ? "NEPA" : t.speaker === "caller" ? "Caller" : "Staff"} <span className="muted small">{mmss(t.atMs)}</span></span>
                      {t.corrected ? <><span>{t.corrected}</span><span className="muted small"> · corrected by {t.correctedBy}. Original: “{t.original}”</span></> : <span>{t.original}</span>}
                      {t.speaker === "caller" && (
                        <details className="fix"><summary className="small">Correct</summary>
                          <ActionForm action={correctAction} className="form-inline">
                            <input type="hidden" name="segmentId" value={t.id} /><input type="hidden" name="callId" value={c.id} />
                            <label className="sr-only" htmlFor={`fix-${t.id}`}>Corrected text</label>
                            <input id={`fix-${t.id}`} name="text" defaultValue={t.corrected ?? t.original} className="note" />
                            <Submit variant="ghost">Save</Submit>
                          </ActionForm>
                        </details>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
