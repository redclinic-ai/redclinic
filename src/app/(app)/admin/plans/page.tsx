import { requireUser } from "@/lib/auth/session-cookie";
import { listPlans } from "@/lib/billing/service";
import { Badge, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { planAction } from "../actions";

export const metadata = { title: "Plans · RedClinic admin" };
const r2 = (p: number | null) => (p == null ? "" : String(p / 100));

export default async function PlansPage() {
  const user = await requireUser();
  const r = await listPlans(user);
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <PageHeader title="Plans" subtitle="Prices in rupees, before GST. Plans stay in draft until you confirm the launch prices." />
      {r.value.map((p) => (
        <ActionForm key={p.id} action={planAction} className="card">
          <input type="hidden" name="id" value={p.id} />
          <h2 className="h2">{p.name} <Badge status={p.status === "active" ? "active" : p.status === "draft" ? "draft" : "deactivated"} label={p.status} /></h2>
          {p.notes && <p className="muted small">{p.notes}</p>}
          <div className="row3">
            <Input label="Name" name="name" defaultValue={p.name} />
            <Input label="Monthly price (₹)" name="priceMonthly" type="number" defaultValue={r2(p.priceMonthlyPaise)} required={false} />
            <Input label="Annual price (₹)" name="priceAnnual" type="number" defaultValue={r2(p.priceAnnualPaise)} required={false} hint="11 × monthly gives one month free." />
            <Input label="Voice minutes per period" name="voiceMinutes" type="number" defaultValue={p.limits.voice_minutes ?? 0} />
            <Input label="Extra minute (₹)" name="overagePerMinute" type="number" defaultValue={r2(p.overagePerMinutePaise)} required={false} hint="Leave empty to not bill extra minutes." />
            <Input label="Staff accounts" name="staffAccounts" type="number" defaultValue={p.limits.staff_accounts ?? 5} />
            <Input label="Setup and training fee (₹)" name="setupFee" type="number" defaultValue={r2(p.setupFeePaise)} required={false} />
            <Input label="GST %" name="gstPercent" type="number" defaultValue={p.gstPercent} />
            <Input label="Trial days" name="trialDays" type="number" defaultValue={p.trialDays} />
          </div>
          <Input label="Description" name="description" defaultValue={p.description ?? ""} required={false} />
          <label className="check"><input type="checkbox" name="outboundCalls" defaultChecked={!!p.limits.outbound_calls} /> <span>Includes outgoing calls (reminders, follow-ups, recalls)</span></label>
          <div className="form-inline">
            <Select label="Status" name="status" required defaultValue={p.status} options={[["draft", "Draft"], ["active", "Active (for sale)"], ["retired", "Retired"]]} />
            <Input label="Notes" name="notes" defaultValue={p.notes ?? ""} required={false} />
            <Submit>Save plan</Submit>
          </div>
        </ActionForm>
      ))}
    </>
  );
}
