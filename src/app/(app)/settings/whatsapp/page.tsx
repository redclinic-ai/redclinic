import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { getWhatsAppSettings } from "@/lib/whatsapp/service";
import { TEMPLATES } from "@/lib/whatsapp/templates";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { saveWhatsAppAction } from "../actions";

export const metadata = { title: "WhatsApp · RedClinic" };

export default async function WhatsAppSettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const { ok } = await searchParams;
  const r = await getWhatsAppSettings(user);
  if (!r.ok) return <p>{r.error}</p>;
  const s = r.value;
  const statusOptions: [string, string][] = [["off", "Off"]];
  if (s.simulatedAllowed) statusOptions.push(["simulated", "Test mode (messages are simulated, nothing reaches patients)"]);
  if (!s.provider.simulated || s.status === "connected") statusOptions.push(["connected", "Connected to WhatsApp Business"]);
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="WhatsApp" subtitle="Appointment confirmations, directions, check-ins and next-visit reminders on WhatsApp."
        actions={<Badge status={s.status === "off" ? "deactivated" : "active"} label={s.status === "off" ? "Off" : s.status === "simulated" ? "Test mode" : "Connected"} />} />
      {s.provider.simulated && (
        <div className="alert alert-sim small">RedClinic has not connected a WhatsApp Business account yet, so only test mode is available. Nothing is sent to patients in test mode.</div>
      )}
      <ActionForm action={saveWhatsAppAction} className="card">
        <Select label="WhatsApp" name="status" defaultValue={s.status} options={statusOptions} />
        <div className="row2">
          <Input label="Clinic WhatsApp number" name="businessNumber" defaultValue={s.businessNumber} required={false} inputMode="tel" hint="With country code, e.g. 91 98450 12345. Patients' replies to this number reach RedClinic." />
          <Input label="Number id (from WhatsApp Manager)" name="phoneNumberId" defaultValue={s.phoneNumberId} required={false} inputMode="numeric" hint="Only needed when connected. RedClinic support can fill this in." />
        </div>
        <Input label="Directions link" name="mapsUrl" defaultValue={s.mapsUrl} required={false} hint="Google Maps → your clinic → Share → Copy link. Sent to patients who missed a confirmed appointment." />
        <Input label="Google review link" name="reviewUrl" defaultValue={s.reviewUrl} required={false} hint="Google Business Profile → Ask for reviews → Copy link. Used only if you switch on review requests." />
        <Submit>Save</Submit>
      </ActionForm>
      <section className="card">
        <h2 className="h2">Who gets messages</h2>
        <p>{s.counts.opted_in} of {s.counts.patients} patients have agreed to WhatsApp messages{s.counts.opted_out ? `; ${s.counts.opted_out} said no` : ""}. Record each patient's answer on their page. Patients can reply STOP at any time.</p>
        <p className="muted small">Messages are sent only between 9 am and 9 pm. Workflows that message patients are in Workflows → WhatsApp workflows, switched off until you turn them on.</p>
      </section>
      <section className="card">
        <h2 className="h2">Message wording</h2>
        <p className="muted small">WhatsApp only delivers wording approved in your WhatsApp Business account. RedClinic submits these for approval when connecting.</p>
        <ul className="mini-list">{Object.entries(TEMPLATES).map(([k, t]) => (
          <li key={k}><strong>{t.label}</strong> <span className="muted small">· replies: {t.replies}</span><div className="small">{t.text.en}</div></li>
        ))}</ul>
      </section>
    </>
  );
}
