import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listLeads } from "@/lib/leads/service";
import { Badge, Empty, Flash, fmtDateTime, PageHeader, Simulated } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { addLeadAction, leadStatusAction } from "./actions";

export const metadata = { title: "Leads · RedClinic" };
const STAGE: Record<string, string> = { new: "New", contacted: "Contacted", booked: "Booked", not_interested: "Not interested", duplicate: "Duplicate" };
const BADGE: Record<string, string> = { new: "pending", contacted: "scheduled", booked: "confirmed", not_interested: "cancelled", duplicate: "deactivated" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ stage?: string; days?: string; ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "view_patients");
  const sp = await searchParams;
  const r = await listLeads(user, { stage: sp.stage, days: Number(sp.days) || 30 });
  if (!r.ok) return <p>{r.error}</p>;
  const { leads, counts, days } = r.value;
  const tab = (stage: string, label: string) => <Link href={`/leads?stage=${stage}&days=${days}`} aria-current={(sp.stage ?? "all") === stage ? "page" : undefined}>{label} ({counts[stage] ?? 0})</Link>;
  return (
    <>
      <Flash ok={sp.ok} />
      <PageHeader title="Leads" subtitle={`Enquiries from lead ads and new contacts, last ${days} days. ${counts.booked} of ${counts.all} booked.`} />
      <nav className="subnav" aria-label="Filter">
        {tab("all", "All")}{tab("new", "New")}{tab("contacted", "Contacted")}{tab("booked", "Booked")}{tab("not_interested", "Not interested")}
      </nav>
      {caps.has("edit_patient") && (
        <details className="card">
          <summary><strong>Add an enquiry by hand</strong> <span className="muted small">— a walk-in, a referral, a call to a staff mobile</span></summary>
          <ActionForm action={addLeadAction}>
            <div className="row3">
              <Input label="Name" name="name" required />
              <Input label="Mobile" name="phone" inputMode="tel" required />
              <Input label="What they asked about" name="problem" required={false} />
            </div>
            <label className="check"><input type="checkbox" name="whatsappOptIn" /> They agreed to WhatsApp messages</label>
            <p className="field-hint">If the lead follow-up workflow is on, NEPA follows up just like a lead-ad enquiry.</p>
            <Submit>Add enquiry</Submit>
          </ActionForm>
        </details>
      )}
      {leads.length === 0 ? <Empty title="No leads yet">Link your Facebook or Instagram lead form in Settings → Lead ads, or add an enquiry by hand.</Empty> : (
        <ul className="list">
          {leads.map((l) => (
            <li key={l.id} className="list-item">
              <div className="att-head">
                <strong>{l.patientId ? <Link href={`/patients/${l.patientId}`}>{l.name}</Link> : l.name}</strong>
                <Badge status={BADGE[l.stage]} label={STAGE[l.stage]} /> {l.simulated && <Simulated />}
                <span className="muted small">{fmtDateTime(l.createdAt)} · {l.source === "meta_lead_ad" ? `Lead ad${l.formLabel ? `: ${l.formLabel}` : ""}` : "Added by staff"}</span>
              </div>
              <p className="small">{l.phone ?? "no number"}{l.patientCode ? ` · ${l.patientCode}` : ""}{l.lastCall ? ` · last call ${fmtDateTime(l.lastCall)}` : ""}</p>
              {Object.keys(l.answers).length > 0 && <p className="muted small">{Object.entries(l.answers).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}</p>}
              {l.campaign.campaign_name && <p className="muted small">Campaign: {l.campaign.campaign_name}{l.campaign.ad_name ? ` · ad: ${l.campaign.ad_name}` : ""}</p>}
              {caps.has("manage_attention") && l.stage !== "booked" && (
                <ActionForm action={leadStatusAction} className="inline-form">
                  <input type="hidden" name="id" value={l.id} />
                  {l.stage !== "contacted" && <Submit variant="ghost" name="status" value="contacted">Mark contacted</Submit>}
                  {l.stage !== "not_interested" ? <Submit variant="ghost" name="status" value="not_interested">Not interested</Submit>
                    : <Submit variant="ghost" name="status" value="new">Put back as new</Submit>}
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
