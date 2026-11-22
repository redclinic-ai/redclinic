import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf } from "@/lib/nav";
import { getClinic, DAYS, LANGUAGES } from "@/lib/clinic/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { saveProfileAction } from "./actions";

export const metadata = { title: "Clinic settings · RedClinic" };
const DAY_NAMES: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

export default async function ClinicSettings() {
  const user = await requireUser();
  const caps = await capabilitiesOf(user);
  if (!caps.has("manage_settings")) redirect(caps.has("manage_staff") ? "/settings/staff" : "/settings/billing");
  const r = await getClinic(user);
  if (!r.ok) return <p>{r.error}</p>;
  const c = r.value;
  return (
    <>
      <PageHeader title="Clinic details" subtitle="Your receptionist and AI receptionist use these details." />
      <ActionForm action={saveProfileAction} className="card form-narrow">
        <Input label="Clinic name" name="name" defaultValue={c.name} />
        <Input label="Address" name="address" defaultValue={c.address ?? ""} required={false} />
        <div className="row2">
          <Input label="City" name="city" defaultValue={c.city ?? ""} required={false} />
          <Input label="Clinic phone" name="phone" type="tel" inputMode="tel" defaultValue={c.phone ?? ""} />
        </div>
        <Input label="Clinic email" name="email" type="email" inputMode="email" defaultValue={c.email ?? ""} required={false} />
        <fieldset>
          <legend>Languages your AI receptionist speaks</legend>
          <div className="chips">
            {Object.entries(LANGUAGES).map(([k, l]) => (
              <label key={k} className="chip"><input type="checkbox" name="languages" value={k} defaultChecked={c.languages.includes(k)} /> {l}</label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Opening hours</legend>
          <div className="hours">
            {DAYS.map((d) => {
              const h = c.workingHours[d];
              return (
                <div key={d} className="hours-row">
                  <label className="check"><input type="checkbox" name={`${d}_open`} defaultChecked={!!h} /> <span>{DAY_NAMES[d]}</span></label>
                  <input aria-label={`${DAY_NAMES[d]} opens`} type="time" name={`${d}_from`} defaultValue={h?.open ?? "09:00"} />
                  <span aria-hidden>to</span>
                  <input aria-label={`${DAY_NAMES[d]} closes`} type="time" name={`${d}_to`} defaultValue={h?.close ?? "18:00"} />
                </div>
              );
            })}
          </div>
        </fieldset>
        <Input label="Usual appointment length (minutes)" name="defaultAppointmentMinutes" type="number" inputMode="numeric" min={5} max={240}
          defaultValue={c.settings.defaultAppointmentMinutes ?? 30} hint="Used when a booking has no service chosen." />
        <Submit>Save details</Submit>
      </ActionForm>
    </>
  );
}
