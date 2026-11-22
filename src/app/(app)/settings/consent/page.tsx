import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { currentConsentWordings } from "@/lib/clinic/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { saveConsentAction } from "../actions";

export const metadata = { title: "Consent wording · RedClinic" };

export default async function ConsentPage() {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const r = await currentConsentWordings(user);
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <PageHeader title="Patient consent wording" subtitle="Read this to patients (or have them sign it) before recording consent. Every change is kept as a new version." />
      {r.value.map((w) => (
        <ActionForm key={w.language} action={saveConsentAction} className="card">
          <h2 className="h2">{w.language === "en" ? "English" : "Hindi"} <span className="muted small">· {w.isDefault ? "RedClinic default" : `your version ${w.version.replace("clinic-v", "")}`}</span></h2>
          <input type="hidden" name="language" value={w.language} />
          <label className="sr-only" htmlFor={`w-${w.language}`}>Wording</label>
          <textarea id={`w-${w.language}`} name="wording" rows={5} defaultValue={w.wording} lang={w.language} />
          <p className="field-hint">Have a lawyer check any change before you use it.</p>
          <Submit>Save as new version</Submit>
        </ActionForm>
      ))}
    </>
  );
}
