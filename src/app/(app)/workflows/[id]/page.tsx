import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listWorkflows, workflowHistory, workflowRuns } from "@/lib/workflows/service";
import { definitionSchema, describeStep } from "@/lib/workflows/definition";
import { Badge, Flash, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { saveWorkflowAction, switchAction } from "../actions";
import { WorkflowEditor } from "../editor";

export const metadata = { title: "Workflow · RedClinic" };

export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "edit_workflow", "manage_settings");
  const { id } = await params;
  const { ok } = await searchParams;
  const [all, hist, runs] = await Promise.all([listWorkflows(user), workflowHistory(user, id), workflowRuns(user, id)]);
  const w = all.ok ? all.value.find((x) => x.id === id) : undefined;
  if (!w) notFound();
  const canEdit = caps.has("edit_workflow");
  const upd = w.updateAvailable ? definitionSchema.safeParse(w.updateAvailable.definition) : null;
  const back = `/workflows/${id}`;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={w.name} back={{ href: "/workflows", label: "Workflows" }} subtitle={w.description ?? undefined}
        actions={<Badge status={w.enabled ? "active" : "deactivated"} label={w.enabled ? (w.automatic ? "On · automatic" : "On · asks staff") : "Off"} />} />
      {w.updateAvailable && upd?.success && (
        <section className="card">
          <h2 className="h2">RedClinic's updated version</h2>
          <ul className="steps-list">{upd.data.steps.map((s, i) => <li key={i}>{describeStep(s)}</li>)}</ul>
          {canEdit && (
            <ActionForm action={switchAction} className="inline-form">
              <input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />
              <Submit name="op" value="update">Use RedClinic's version</Submit>
              <Submit variant="ghost" name="op" value="keep">Keep mine</Submit>
            </ActionForm>
          )}
          <p className="field-hint">Your current version stays in the history either way.</p>
        </section>
      )}
      {canEdit && w.definition ? (
        <ActionForm action={saveWorkflowAction} className="card">
          <input type="hidden" name="id" value={id} />
          <WorkflowEditor name={w.name} def={w.definition} />
          <Input label="What changed (for the history)" name="note" required={false} />
          <Submit>Save as new version</Submit>
        </ActionForm>
      ) : <section className="card"><ul className="steps-list">{w.summary.map((s, i) => <li key={i}>{s}</li>)}</ul></section>}
      <div className="grid2">
        <section className="card">
          <h2 className="h2">History</h2>
          {hist.ok && hist.value.length ? (
            <ActionForm action={switchAction}>
              <input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={back} />
              <ul className="mini-list">{hist.value.map((h) => (
                <li key={h.version} className="hist-row">
                  <span>v{h.version} · {fmtDateTime(h.at)}{h.by ? ` · ${h.by}` : ""} · {h.note}</span>
                  {canEdit && h.version !== w.version && <Submit variant="ghost" name="op" value={`restore:${h.version}`} pending="…">Restore</Submit>}
                </li>
              ))}</ul>
            </ActionForm>
          ) : <p className="muted">Not changed yet.</p>}
        </section>
        <section className="card">
          <h2 className="h2">Recent runs</h2>
          {runs.ok && runs.value.length ? (
            <ul className="mini-list">{runs.value.map((r) => (
              <li key={r.id}><strong>{r.patient}</strong> · <Badge status={r.status === "active" ? "pending" : r.status === "done" ? "completed" : r.status} label={r.status} />
                <div className="muted small">{r.log.map((l) => `${l.step}: ${l.result}`).join(" · ") || (r.nextDueAt ? `Next step ${fmtDateTime(r.nextDueAt)}` : "")}{r.stopReason ? ` · ${r.stopReason}` : ""}</div></li>
            ))}</ul>
          ) : <p className="muted">Nothing has run yet.</p>}
        </section>
      </div>
    </>
  );
}
