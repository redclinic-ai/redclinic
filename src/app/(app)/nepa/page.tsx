import { requireUser } from "@/lib/auth/session-cookie";
import { contextOf } from "@/lib/auth/service";
import { withContext } from "@/lib/db";
import { getConfig, type ClinicConfig } from "@/lib/nepa/config";
import { resolve } from "@/lib/nepa/resolver";
import { Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select, TextArea } from "@/components/form";
import { PermissionEditor } from "@/components/permission-editor";
import { saveClinicNepaAction } from "./actions";
import { VersionBar } from "./version-bar";

export const metadata = { title: "AI receptionist · RedClinic" };

export default async function NepaClinicPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { ok } = await searchParams;
  const { cfg, conflicts } = await withContext(contextOf(user), async (c) => {
    const cfg = await getConfig(c, null);
    const r = await resolve(c, "receptionist", { useDrafts: true });
    return { cfg, conflicts: r.conflicts.filter((x) => x.layer === "clinic") };
  });
  const d = (cfg.draft?.data ?? cfg.effective) as ClinicConfig;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="AI receptionist" subtitle="How NEPA speaks for your clinic. RedClinic's safety rules always come first and can't be changed here." />
      <VersionBar published={cfg.published} draft={cfg.draft} history={cfg.history} />
      {conflicts.length > 0 && (
        <div className="alert alert-error" role="alert">
          <strong>Some instructions clash with RedClinic's rules:</strong>
          <ul className="alert-links">{conflicts.map((c, i) => <li key={i}>{c.message} {c.resolution}</li>)}</ul>
        </div>
      )}
      <ActionForm action={saveClinicNepaAction} className="card">
        <h2 className="h2">Greeting</h2>
        <p className="field-hint">NEPA always starts by saying it is the clinic's AI receptionist and that the call may be recorded. Your greeting follows.</p>
        <Input label="English" name="greeting_en" defaultValue={d.greeting.en ?? ""} required={false} placeholder="How can I help you today?" />
        <Input label="Hindi" name="greeting_hi" defaultValue={d.greeting.hi ?? ""} required={false} />
        <Input label="Kannada" name="greeting_kn" defaultValue={d.greeting.kn ?? ""} required={false} />
        <h2 className="h2">Manner</h2>
        <div className="row3">
          <Select label="Tone" name="tone" required defaultValue={d.tone} options={[["warm", "Warm"], ["friendly", "Friendly"], ["formal", "Formal"]]} />
          <Select label="Start in" name="preferredLanguage" required defaultValue={d.preferredLanguage} options={[["en", "English"], ["hi", "Hindi"], ["kn", "Kannada"]]} />
          <label className="check" style={{ alignSelf: "end" }}><input type="checkbox" name="languageSwitching" defaultChecked={d.languageSwitching} /> <span>Switch to the caller's language</span></label>
        </div>
        <TextArea label="Personality (optional)" name="personality" defaultValue={d.personality} rows={2} />
        <TextArea label="Appointment rules" name="appointmentPolicy" defaultValue={d.appointmentPolicy} rows={2} hint="e.g. New patients get 30 minutes. Root canals only in the mornings." />
        <TextArea label="Other instructions" name="instructions" defaultValue={d.instructions} rows={3} />
        <h2 className="h2">Handing over to staff</h2>
        <div className="row2">
          <Input label="Staff mobile for handover" name="fallbackNumber" type="tel" inputMode="tel" defaultValue={d.escalation.fallbackNumber} required={false} />
          <TextArea label="Words that always go to staff (one per line)" name="keywords" defaultValue={d.escalation.keywords.join("\n")} rows={3} />
        </div>
        <PermissionEditor legend="What NEPA may do on its own" value={d.permissions} />
        <Input label="What changed (for the history)" name="note" required={false} />
        <div className="form-actions">
          <Submit variant="ghost">Save draft</Submit>
          <Submit name="publish" value="1" pending="Publishing…">Save and publish</Submit>
        </div>
      </ActionForm>
    </>
  );
}
