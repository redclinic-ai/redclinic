import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { listDoctors } from "@/lib/patients/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { registerAction } from "../actions";
import { PatientFields } from "../patient-form";

export const metadata = { title: "New patient · RedClinic" };

export default async function NewPatientPage({ searchParams }: { searchParams: Promise<{ name?: string; next?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "edit_patient");
  const { name, next } = await searchParams;
  const d = await listDoctors(user);
  return (
    <>
      <PageHeader title="New patient" subtitle="Only the name is needed. A permanent patient ID is created." back={{ href: "/patients", label: "Patients" }} />
      <ActionForm action={registerAction} className="card form-narrow">
        <input type="hidden" name="from" value={next ?? ""} />
        <PatientFields p={{ name }} doctors={d.ok ? d.value : []} />
        <label className="check"><input type="checkbox" name="confirmNew" /> <span>This is a different person (add even if a similar patient exists)</span></label>
        <div className="form-actions">
          <Submit name="next" value="book" pending="Saving…">Save and book appointment</Submit>
          <Submit variant="ghost" pending="Saving…">Save</Submit>
        </div>
      </ActionForm>
    </>
  );
}
