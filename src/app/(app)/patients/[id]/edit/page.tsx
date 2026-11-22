import { requirePageCap } from "@/lib/nav";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { getPatient, listDoctors } from "@/lib/patients/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { editAction } from "../../actions";
import { PatientFields } from "../../patient-form";

export const metadata = { title: "Edit patient · RedClinic" };

export default async function EditPatientPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "edit_patient");
  const { id } = await params;
  const [p, d] = await Promise.all([getPatient(user, id), listDoctors(user)]);
  if (!p.ok) notFound();
  return (
    <>
      <PageHeader title={`Edit ${p.value.name}`} subtitle={`Patient ID ${p.value.code} never changes, even if the phone number does.`} back={{ href: `/patients/${id}`, label: p.value.name }} />
      <ActionForm action={editAction} className="card form-narrow">
        <input type="hidden" name="id" value={id} />
        <PatientFields p={p.value} doctors={d.ok ? d.value : []} />
        <Submit>Save</Submit>
      </ActionForm>
    </>
  );
}
