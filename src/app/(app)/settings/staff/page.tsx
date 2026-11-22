import { requirePageCap } from "@/lib/nav";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { listStaff } from "@/lib/staff/service";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { inviteAction } from "../actions";

export const metadata = { title: "Staff · RedClinic" };
export const ROLE_LABEL: Record<string, string> = { clinic_admin: "Clinic admin", doctor: "Doctor", receptionist: "Receptionist", clinic_manager: "Clinic manager" };

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_staff");
  const { ok } = await searchParams;
  const r = await listStaff(user);
  if (!r.ok) return <p>{r.error}</p>;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="Staff" subtitle="Add your doctors and receptionists. Each person gets an email to choose their password." />
      <ActionForm action={inviteAction} className="card">
        <h2 className="h2">Add a staff member</h2>
        <div className="row3">
          <Input label="Name" name="displayName" autoComplete="name" />
          <Input label="Email" name="email" type="email" inputMode="email" />
          <Select label="Role" name="role" required defaultValue="receptionist"
            options={[["receptionist", "Receptionist"], ["doctor", "Doctor"], ["clinic_manager", "Clinic manager"]]} />
        </div>
        <p className="field-hint">They start with the usual permissions for their role. You can change them after.</p>
        <Submit pending="Sending…">Send invitation</Submit>
      </ActionForm>
      <ul className="list">
        {r.value.map((s) => (
          <li key={s.id} className="list-item list-row">
            <div>
              <Link href={`/settings/staff/${s.id}`} className="strong">{s.displayName}</Link>
              <div className="muted small">{ROLE_LABEL[s.role]} · {s.email}</div>
            </div>
            <div className="row-end">
              {s.status === "deactivated" ? <Badge status="deactivated" label="Switched off" /> : !s.hasPassword ? <Badge status="pending" label="Invitation sent" /> : <Badge status="active" label="Active" />}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
