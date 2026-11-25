import { requirePageCap } from "@/lib/nav";
import { requireUser } from "@/lib/auth/session-cookie";
import { getDataPolicy, RETENTION_CHOICES } from "@/lib/privacy/service";
import { Badge, Flash, fmtDateTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Select } from "@/components/form";
import { decideGrantAction, saveDataPolicyAction } from "../actions";

export const metadata = { title: "Privacy & data · RedClinic" };

const keep: [string, string][] = RETENTION_CHOICES.map((d) => [d === null ? "" : String(d), d === null ? "Keep" : d < 365 ? `${d} days` : `${d / 365} year${d > 365 ? "s" : ""}`]);

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_settings");
  const { ok } = await searchParams;
  const r = await getDataPolicy(user);
  if (!r.ok) return <p>{r.error}</p>;
  const { policy: p, grants } = r.value;
  const v = (n: number | null) => (n === null ? "" : String(n));
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title="Privacy & data" subtitle="Who at RedClinic can open your patient data, and how long call data is kept." />
      {grants.filter((g) => g.status === "requested").map((g) => (
        <section key={g.id} className="card alert-sim">
          <h2 className="h2">RedClinic is asking for access</h2>
          <p><strong>{g.requester}</strong> asked on {fmtDateTime(g.createdAt)} for {g.hours} hours of access.</p>
          <p>Reason: {g.reason}</p>
          <div className="inline-form">
            <ActionForm action={decideGrantAction}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="decision" value="approve" /><Submit>Approve for {g.hours} hours</Submit></ActionForm>
            <ActionForm action={decideGrantAction}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="decision" value="deny" /><Submit variant="ghost">Deny</Submit></ActionForm>
          </div>
        </section>
      ))}
      <ActionForm action={saveDataPolicyAction} className="card">
        <h2 className="h2">RedClinic access to patient data</h2>
        <Select label="RedClinic support may open patient data" name="superAccess" defaultValue={p.superAccess}
          options={[["full", "When needed (every visit is recorded in your audit log)"], ["request", "Only when I approve a request"]]}
          hint="Either way, RedClinic still sees usage numbers and billing, and NEPA keeps working." />
        <h2 className="h2">How long to keep call data</h2>
        <p className="muted small">Patient records, appointments, documents and consent are never deleted by these rules.</p>
        <div className="grid2">
          <Select label="Call recordings" name="recordingDays" options={keep} defaultValue={v(p.recordingDays)} />
          <Select label="Call transcripts" name="transcriptDays" options={keep} defaultValue={v(p.transcriptDays)} hint="Call summaries are kept." />
          <Select label="In-app assistant history" name="assistantLogDays" options={keep} defaultValue={v(p.assistantLogDays)} />
          <Select label="Phone system logs" name="telephonyEventDays" options={keep} defaultValue={v(p.telephonyEventDays)} />
        </div>
        <p className="field-hint">Older data is deleted automatically within a few hours of saving, and then every few hours.{p.lastPurgeAt ? ` Last clean-up ${fmtDateTime(p.lastPurgeAt)}.` : ""} Deleted data cannot be recovered.</p>
        <Submit>Save</Submit>
      </ActionForm>
      {grants.some((g) => g.status !== "requested") && (
        <section className="card">
          <h2 className="h2">Past requests</h2>
          <ul className="mini-list">{grants.filter((g) => g.status !== "requested").map((g) => (
            <li key={g.id}>{fmtDateTime(g.createdAt)} · {g.requester} · {g.hours} h · <Badge status={g.active ? "approved" : g.status} label={g.active ? "Open now" : g.status} />
              <div className="muted small">{g.reason}{g.active && g.expiresAt ? ` · open until ${fmtDateTime(g.expiresAt)}` : ""}</div>
              {g.active && <ActionForm action={decideGrantAction}><input type="hidden" name="id" value={g.id} /><input type="hidden" name="decision" value="revoke" /><Submit variant="ghost">Close access now</Submit></ActionForm>}
            </li>
          ))}</ul>
        </section>
      )}
    </>
  );
}
