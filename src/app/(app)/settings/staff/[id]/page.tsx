import { requirePageCap } from "@/lib/nav";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { CAPABILITY_GROUPS, listCapabilities, listStaff } from "@/lib/staff/service";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { permissionsAction } from "../../actions";
import { ROLE_LABEL } from "../page";

export const metadata = { title: "Staff member · RedClinic" };

export default async function StaffMemberPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_staff");
  const { id } = await params;
  const { ok } = await searchParams;
  const [staff, caps] = await Promise.all([listStaff(user), listCapabilities(user)]);
  if (!staff.ok || !caps.ok) return <p>{!staff.ok ? staff.error : !caps.ok ? caps.error : ""}</p>;
  const s = staff.value.find((x) => x.id === id);
  if (!s) notFound();
  const byCode = new Map(caps.value.map((c) => [c.code, c]));
  const isAdmin = s.role === "clinic_admin";
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={s.displayName} subtitle={`${ROLE_LABEL[s.role]} · ${s.email}`} back={{ href: "/settings/staff", label: "Staff" }}
        actions={s.status === "deactivated" ? <Badge status="deactivated" label="Switched off" /> : undefined} />
      {isAdmin ? (
        <div className="card"><p>The clinic admin can do everything in this clinic.</p></div>
      ) : (
        <ActionForm action={permissionsAction} className="card">
          <input type="hidden" name="id" value={s.id} />
          <h2 className="h2">What {s.displayName.split(" ")[0]} can do</h2>
          {CAPABILITY_GROUPS.map((g) => (
            <fieldset key={g.title}>
              <legend>{g.title}</legend>
              {g.codes.filter((c) => byCode.has(c)).map((c) => {
                const cap = byCode.get(c)!;
                return (
                  <label key={c} className="check">
                    <input type="checkbox" name="cap" value={c} defaultChecked={s.capabilities.includes(c)} disabled={!cap.allowed && !s.capabilities.includes(c)} />
                    <span>{cap.description}{!cap.allowed && <span className="muted small"> (not on your plan)</span>}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          <div className="form-actions">
            <Submit>Save permissions</Submit>
            {s.status === "active" && <Submit variant="danger" name="deactivate" value="1" pending="Switching off…">Switch off account</Submit>}
          </div>
          <p className="field-hint">Switching off signs them out everywhere straight away. Their past work stays in the records.</p>
        </ActionForm>
      )}
    </>
  );
}
