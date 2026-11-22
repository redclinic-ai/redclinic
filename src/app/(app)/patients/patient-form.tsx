import { Input, Select, TextArea } from "@/components/form";
import type { Patient } from "@/lib/patients/service";

/** Shared fields for adding and editing a patient. Short on purpose: only the name is required. */
export function PatientFields({ p, doctors }: { p?: Partial<Patient>; doctors: { id: string; name: string }[] }) {
  return (
    <>
      <Input label="Full name" name="name" defaultValue={p?.name} autoComplete="off" />
      <Input label="Mobile number" name="phone" type="tel" inputMode="tel" defaultValue={p?.phone ?? ""} required={false} />
      <div className="row2">
        <Input label="Age" name="ageYears" type="number" inputMode="numeric" min={0} max={130} defaultValue={p?.ageYears ?? ""} required={false} />
        <Select label="Gender" name="gender" defaultValue={p?.gender ?? ""} options={[["Female", "Female"], ["Male", "Male"], ["Other", "Other"]]} />
      </div>
      {!p?.id && <TextArea label="What did they come for?" name="firstProblem" rows={2} defaultValue={p?.firstProblem ?? ""} />}
      <details className="more-fields" open={!!(p?.email || p?.dateOfBirth || p?.address || p?.assignedDoctorId)}>
        <summary>More details</summary>
        <Input label="Date of birth" name="dateOfBirth" type="date" defaultValue={p?.dateOfBirth ?? ""} required={false} />
        <Input label="Email" name="email" type="email" inputMode="email" defaultValue={p?.email ?? ""} required={false} />
        <Input label="Address" name="address" defaultValue={p?.address ?? ""} required={false} />
        {doctors.length > 0 && <Select label="Usual doctor" name="assignedDoctorId" defaultValue={p?.assignedDoctorId ?? ""} options={doctors.map((d) => [d.id, d.name])} />}
        {p?.id && <TextArea label="First visit reason" name="firstProblem" rows={2} defaultValue={p?.firstProblem ?? ""} />}
      </details>
    </>
  );
}
