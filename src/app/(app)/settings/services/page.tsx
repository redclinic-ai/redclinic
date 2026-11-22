import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { listServices } from "@/lib/clinic/service";
import { Empty, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input } from "@/components/form";
import { saveServiceAction } from "../actions";

export const metadata = { title: "Services · RedClinic" };

export default async function ServicesPage() {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const r = await listServices(user);
  const services = r.ok ? r.value : [];
  return (
    <>
      <PageHeader title="Services" subtitle="What you offer and how long each takes. Used when booking. No prices are stored." />
      <ActionForm action={saveServiceAction} className="card form-inline" resetOnSuccess>
        <Input label="New service" name="name" placeholder="e.g. Root canal treatment" />
        <Input label="Minutes" name="durationMinutes" type="number" inputMode="numeric" defaultValue={30} min={5} max={480} />
        <Submit pending="Adding…">Add</Submit>
      </ActionForm>
      {services.length === 0 ? <Empty title="No services yet">Add the treatments you offer, like check-up, cleaning or root canal.</Empty> : (
        <ul className="list">
          {services.map((s) => (
            <li key={s.id} className="list-item">
              <ActionForm action={saveServiceAction} className="form-inline">
                <input type="hidden" name="id" value={s.id} />
                <Input label="Service" name="name" defaultValue={s.name} />
                <Input label="Minutes" name="durationMinutes" type="number" inputMode="numeric" defaultValue={s.durationMinutes} />
                <label className="check"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> <span>Offered</span></label>
                <Submit variant="ghost">Save</Submit>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
