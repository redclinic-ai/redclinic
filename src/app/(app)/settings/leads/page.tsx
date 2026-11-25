import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { listLeadForms } from "@/lib/leads/service";
import { appBaseUrl } from "@/lib/env";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { addLeadFormAction, leadFormSwitchAction } from "../actions";

export const metadata = { title: "Lead ads · RedClinic" };

export default async function LeadAdsSettings({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const { ok } = await searchParams;
  const r = await listLeadForms(user);
  if (!r.ok) return <p>{r.error}</p>;
  const { forms, provider } = r.value;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="Lead ads" subtitle="Facebook and Instagram lead forms. Each new lead becomes a patient record, and NEPA follows up within minutes." />
      {provider.simulated && <div className="alert alert-sim small">RedClinic has not connected its Meta app yet. You can link forms now; leads arrive once the connection is live (test leads work in the meantime).</div>}
      <section className="card">
        <h2 className="h2">Linked forms</h2>
        {forms.length === 0 ? <p className="muted">No forms linked yet.</p> : (
          <ul className="mini-list">{forms.map((f) => (
            <li key={f.id}>
              <strong>{f.label}</strong> <Badge status={f.enabled ? "active" : "deactivated"} label={f.enabled ? "On" : "Off"} />
              <div className="muted small">Page {f.pageId} · form {f.formId} · {f.leads} lead{f.leads === 1 ? "" : "s"}</div>
              <ActionForm action={leadFormSwitchAction} className="inline-form"><input type="hidden" name="id" value={f.id} />
                <Submit variant="ghost" name="enabled" value={f.enabled ? "0" : "1"}>{f.enabled ? "Stop taking leads" : "Take leads again"}</Submit></ActionForm>
            </li>
          ))}</ul>
        )}
      </section>
      <ActionForm action={addLeadFormAction} className="card">
        <h2 className="h2">Link a lead form</h2>
        <Input label="Name for this form" name="label" required hint="E.g. “Free check-up – Instagram, Nov”." />
        <div className="row2">
          <Input label="Facebook page id" name="pageId" inputMode="numeric" required />
          <Input label="Form id" name="formId" inputMode="numeric" required hint="Meta Ads Manager → All tools → Instant forms → the form → Form id." />
        </div>
        <p className="field-hint">Ask patients for name and phone; add a “whatsapp_opt_in” yes/no question if you want WhatsApp follow-ups. Then switch on “Follow up lead-ad enquiries” in Workflows.</p>
        <Submit>Link form</Submit>
      </ActionForm>
      <p className="muted small">For RedClinic support: Meta webhook address {appBaseUrl()}/api/leads/meta (page subscription, “leadgen” field).</p>
    </>
  );
}
