import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { forwardingCodes, getPhoneSetup } from "@/lib/phone/service";
import { Badge, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { savePhoneAction } from "./actions";

export const metadata = { title: "Phone number · RedClinic" };

export default async function PhonePage() {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const r = await getPhoneSetup(user);
  if (!r.ok) return <p>{r.error}</p>;
  const p = r.value;
  return (
    <>
      <PageHeader title="Clinic phone number" subtitle="Patients keep calling your usual number. You forward calls to NEPA; NEPA hands over to your staff mobile when needed."
        actions={<Badge status={p.status === "verified" ? "active" : "pending"} label={p.status === "verified" ? "Connected" : "Not connected yet"} />} />
      <ActionForm action={savePhoneAction} className="card form-narrow">
        <Input label="Your clinic's number (the one patients call)" name="clinicNumber" type="tel" inputMode="tel" defaultValue={p.clinicNumber} />
        <Input label="Staff mobile for handover" name="fallbackNumber" type="tel" inputMode="tel" defaultValue={p.fallbackNumber} hint="When NEPA can't help, or a caller asks for a person, the call goes here." />
        <Select label="When should NEPA answer?" name="forwardingMode" required defaultValue={p.forwardingMode}
          options={[["when_busy_or_unanswered", "Only when no one at the desk answers (recommended)"], ["always", "Every call"], ["after_hours", "Only when the clinic is closed"]]} />
        <Submit>Save</Submit>
      </ActionForm>
      <section className="card">
        <h2 className="h2">How to forward your calls</h2>
        {p.receptionistNumber ? (
          <>
            <p>From the clinic phone, dial the code and press call. You hear a confirmation tone or message.</p>
            <ul className="mini-list">
              {forwardingCodes(p.receptionistNumber).filter((c) => c.mode === "off" || p.forwardingMode === "always" ? c.mode === "always" || c.mode === "off" : c.mode !== "always").map((c) => (
                <li key={c.code}><strong className="code">{c.code}</strong> · {c.label}</li>
              ))}
            </ul>
            <p className="small muted">These codes work on Jio, Airtel, Vi and BSNL mobiles and most landlines. For a landline with an exchange (EPABX), ask your phone vendor to set “forward on no answer” to this number.</p>
            <ol className="steps">
              <li>Dial the code from the clinic phone.</li>
              <li>From another phone, call the clinic and let it ring. NEPA should answer.</li>
              <li>Ask NEPA for a person. Your staff mobile should ring.</li>
            </ol>
          </>
        ) : (
          <p>RedClinic will give you your NEPA number once calling is switched on for your clinic. Meanwhile you can try NEPA with a <a href="/calls/test">test call</a>.</p>
        )}
      </section>
    </>
  );
}
