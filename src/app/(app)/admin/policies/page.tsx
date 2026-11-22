import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { listPolicies } from "@/lib/nepa/policies";
import { Badge, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select, TextArea } from "@/components/form";
import { savePolicyAction } from "./actions";

export const metadata = { title: "Global policies · RedClinic" };

export default async function PoliciesPage() {
  const user = await requireUser();
  const r = await listPolicies(user);
  const policies = r.ok ? r.value : [];
  return (
    <>
      <PageHeader title="Global policies" subtitle="Rules every NEPA agent in every clinic follows. Clinics cannot override mandatory policies." />
      <ul className="list">
        {policies.map((p) => (
          <li key={p.policyId}>
            <Link href={`/admin/policies/${p.policyId}`} className="list-item list-row link-row">
              <div><span className="strong">{p.title}</span> <span className="muted small">· {p.category} · v{p.version}</span><div className="muted small">{p.ruleText}</div></div>
              <div className="row-end">{p.mandatory ? <Badge status="active" label="Mandatory" /> : <Badge status="draft" label="Default" />}{!p.active && <Badge status="deactivated" label="Off" />}</div>
            </Link>
          </li>
        ))}
      </ul>
      <details className="card more-fields">
        <summary>Add a policy</summary>
        <ActionForm action={savePolicyAction}>
          <div className="row2">
            <Input label="Short key" name="key" placeholder="e.g. no_insurance_promises" />
            <Select label="Category" name="category" required defaultValue="quality" options={[["legal", "Legal"], ["privacy", "Privacy"], ["safety", "Safety"], ["behaviour", "Behaviour"], ["quality", "Quality"]]} />
          </div>
          <Input label="Title" name="title" />
          <TextArea label="Rule (what NEPA must do)" name="ruleText" rows={3} />
          <label className="check"><input type="checkbox" name="mandatory" defaultChecked /> <span>Mandatory</span></label>
          <label className="check"><input type="checkbox" name="active" defaultChecked /> <span>Active</span></label>
          <Input label="Why (kept in the history)" name="note" />
          <Submit>Add policy</Submit>
        </ActionForm>
      </details>
    </>
  );
}
