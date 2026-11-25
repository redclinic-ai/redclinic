import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { getTelehealth } from "@/lib/telehealth/service";
import { Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { saveTelehealthAction } from "../actions";

export const metadata = { title: "Online consultations · RedClinic" };

export default async function OnlineSettings({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const { ok } = await searchParams;
  const r = await getTelehealth(user);
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="Online consultations" subtitle="Video consultations in the browser. Each appointment gets its own private room; the patient joins from a link." />
      <ActionForm action={saveTelehealthAction} className="card">
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={r.value.enabled} /> Offer online consultations</label>
        <Input label="Video server" name="jitsiDomain" defaultValue={r.value.jitsiDomain} hint="meet.jit.si is the free public Jitsi service, fine for trying it. For real patients, RedClinic support sets up a private Jitsi server and enters its address here." />
        <p className="field-hint">RedClinic does not take or record payments for consultations.</p>
        <Submit>Save</Submit>
      </ActionForm>
    </>
  );
}
