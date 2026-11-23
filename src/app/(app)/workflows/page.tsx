import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { listWorkflows } from "@/lib/workflows/service";
import { Badge, Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { switchAction } from "./actions";

export const metadata = { title: "Workflows · RedClinic" };
const PACK: Record<string, string> = { core: "For every clinic", dental_pack: "Dental Pack" };

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const caps = await requirePageCap(user, "edit_workflow", "manage_settings");
  const { ok } = await searchParams;
  const r = await listWorkflows(user);
  if (!r.ok) return <p>{r.error}</p>;
  const canEdit = caps.has("edit_workflow");
  const isAdmin = user.role === "clinic_admin";
  const groups = [...new Set(r.value.map((w) => (w.format === 2 ? w.packKey ?? "custom" : "old")))];
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="Workflows" subtitle="What NEPA does after bookings, visits and missed appointments. Every call asks staff first unless you make that workflow automatic."
        actions={canEdit && <Link className="btn btn-primary" href="/workflows/new"><Icon name="plus" size={18} /> New workflow</Link>} />
      {groups.map((g) => (
        <section key={g} aria-label={PACK[g] ?? g}>
          <h2 className="h2 group-title">{PACK[g] ?? (g === "custom" ? "Your own workflows" : "Older format")}{g === "dental_pack" && <Badge status="draft" label="Draft: to be reviewed by a dentist" />}</h2>
          <ul className="list">
            {r.value.filter((w) => (w.format === 2 ? w.packKey ?? "custom" : "old") === g).map((w) => (
              <li key={w.id} className="list-item wf">
                <div className="wf-head">
                  <Link href={`/workflows/${w.id}`} className="strong">{w.name}</Link>
                  <Badge status={w.enabled ? "active" : "deactivated"} label={w.enabled ? (w.automatic ? "On · automatic" : "On · asks staff") : "Off"} />
                  {w.editedByClinic && <span className="muted small">edited by you</span>}
                </div>
                {w.description && <p className="muted small">{w.description}</p>}
                <ul className="steps-list">{w.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                {w.updateAvailable && <p className="alert alert-sim small">RedClinic has an updated version of this workflow. <Link href={`/workflows/${w.id}`}>Compare and decide</Link></p>}
                {canEdit && (
                  <ActionForm action={switchAction} className="inline-form">
                    <input type="hidden" name="id" value={w.id} />
                    {w.enabled ? <Submit variant="ghost" name="op" value="off">Switch off</Submit> : <Submit variant="ghost" name="op" value="on">Switch on</Submit>}
                    {w.enabled && isAdmin && (w.automatic ? <Submit variant="ghost" name="op" value="manual">Ask staff first</Submit> : <Submit variant="ghost" name="op" value="auto">Make automatic</Submit>)}
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
