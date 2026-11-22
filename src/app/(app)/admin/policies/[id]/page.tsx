import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { listPolicies, policyHistory } from "@/lib/nepa/policies";
import { Badge, Flash, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, TextArea } from "@/components/form";
import { rollbackPolicyAction, savePolicyAction } from "../actions";

export const metadata = { title: "Policy · RedClinic" };

export default async function PolicyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { ok } = await searchParams;
  const [all, hist] = await Promise.all([listPolicies(user), policyHistory(user, id)]);
  const p = all.ok ? all.value.find((x) => x.policyId === id) : undefined;
  if (!p || !hist.ok) notFound();
  const locked = p.priority === 1;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 16) : "");
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={p.title} subtitle={`${p.key} · ${p.category} · live version ${p.version}`} back={{ href: "/admin/policies", label: "Global policies" }} />
      <ActionForm action={savePolicyAction} className="card">
        <input type="hidden" name="id" value={id} />
        <Input label="Title" name="title" defaultValue={p.title} />
        <TextArea label="Rule" name="ruleText" defaultValue={p.ruleText} rows={4} />
        <div className="row2">
          <Input label="Effective from" name="effectiveFrom" type="datetime-local" defaultValue={iso(p.effectiveFrom)} required={false} />
          <Input label="Effective until" name="effectiveTo" type="datetime-local" defaultValue={iso(p.effectiveTo)} required={false} />
        </div>
        <label className="check"><input type="checkbox" name="mandatory" defaultChecked={p.mandatory} disabled={locked} /> <span>Mandatory{locked && " (legal, privacy and safety policies always are)"}</span></label>
        {locked && <input type="hidden" name="mandatory" value="on" />}
        <label className="check"><input type="checkbox" name="active" defaultChecked={p.active} disabled={locked} /> <span>Active</span></label>
        {locked && <input type="hidden" name="active" value="on" />}
        <Input label="Why you are changing it (kept in the history)" name="note" />
        <Submit>Save as new version</Submit>
      </ActionForm>
      <section className="card">
        <h2 className="h2">History</h2>
        <ActionForm action={rollbackPolicyAction}>
          <input type="hidden" name="id" value={id} />
          <ul className="mini-list">
            {hist.value.map((h) => (
              <li key={h.id}>
                <strong>v{h.version}</strong> {h.isCurrent && <Badge status="active" label="Live" />} {!h.active && <Badge status="deactivated" label="Off" />}
                <span className="muted small"> · {fmtDateTime(h.createdAt)}{h.by ? ` · ${h.by}` : ""}{h.note ? ` · ${h.note}` : ""}</span>
                <div className="small">{h.ruleText}</div>
                {!h.isCurrent && <Submit variant="ghost" name="versionId" value={h.id} pending="…">Make this version live</Submit>}
              </li>
            ))}
          </ul>
        </ActionForm>
      </section>
    </>
  );
}
