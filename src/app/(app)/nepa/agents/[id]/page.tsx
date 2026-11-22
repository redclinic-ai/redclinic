import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { contextOf } from "@/lib/auth/service";
import { withContext } from "@/lib/db";
import { getConfig, AGENT_LABEL, type AgentConfig, type ClinicConfig } from "@/lib/nepa/config";
import { resolve } from "@/lib/nepa/resolver";
import { Flash, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select, TextArea } from "@/components/form";
import { PermissionEditor } from "@/components/permission-editor";
import { saveAgentAction, versionAction } from "../../actions";
import { VersionBar } from "../../version-bar";

export const metadata = { title: "NEPA agent · RedClinic" };

export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { ok } = await searchParams;
  const data = await withContext(contextOf(user), async (c) => {
    const a = (await c.query("SELECT * FROM nepa_agents WHERE id = $1", [id])).rows[0];
    if (!a) return null;
    const cfg = await getConfig(c, a.id, a.kind);
    const clinic = (await getConfig(c, null)).effective as ClinicConfig;
    const r = await resolve(c, a.kind, { useDrafts: true });
    return { a, cfg, clinic, conflicts: r.conflicts.filter((x) => x.layer === "agent"), clinicLangs: r.knowledge.clinic.languages };
  }).catch(() => null);
  if (!data) notFound();
  const { a, cfg, clinic, conflicts, clinicLangs } = data;
  const d = (cfg.draft?.data ?? cfg.effective) as AgentConfig;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={AGENT_LABEL[a.kind]} back={{ href: "/nepa/agents", label: "Agents" }}
        actions={<ActionForm action={versionAction} className="inline-form"><input type="hidden" name="agentId" value={a.id} />
          {a.enabled ? <Submit variant="ghost" name="op" value="disable">Switch off</Submit> : <Submit name="op" value="enable">Switch on</Submit>}</ActionForm>} />
      <VersionBar agentId={a.id} published={cfg.published} draft={cfg.draft} history={cfg.history} />
      {conflicts.length > 0 && (
        <div className="alert alert-error" role="alert"><ul className="alert-links">{conflicts.map((c, i) => <li key={i}>{c.message} {c.resolution}</li>)}</ul></div>
      )}
      <ActionForm action={saveAgentAction} className="card">
        <input type="hidden" name="agentId" value={a.id} />
        <h2 className="h2">Profile</h2>
        <div className="row2">
          <Input label="Name it uses on calls" name="name" defaultValue={d.name} />
          <Input label="Voice ID (Cartesia)" name="voiceId" defaultValue={d.voice.voiceId} required={false} hint="Set when voice calls are connected." />
        </div>
        <TextArea label="Its job" name="objective" defaultValue={d.objective} rows={2} />
        <TextArea label="Personality (optional)" name="personality" defaultValue={d.personality} rows={2} />
        <fieldset><legend>Languages</legend><div className="chips">
          {(["en", "hi", "kn"] as const).map((l) => (
            <label key={l} className="chip"><input type="checkbox" name="languages" value={l} defaultChecked={d.languages.includes(l)} disabled={!clinicLangs.includes(l) && !d.languages.includes(l)} /> {l === "en" ? "English" : l === "hi" ? "Hindi" : "Kannada"}</label>
          ))}
        </div></fieldset>
        <div className="row2">
          <Select label="Knowledge it may use" name="knowledgeScope" required defaultValue={d.knowledgeScope} options={[["all", "Clinic details and approved answers"], ["faq_only", "Approved answers only"], ["none", "None (only its script)"]]} />
          <Select label="When it works" name="operatingHours" required defaultValue={d.operatingHours} options={[["clinic", "Clinic opening hours"], ["after_hours_only", "Only when the clinic is closed"], ["always", "Always"]]} />
        </div>
        <h2 className="h2">Scripts</h2>
        <TextArea label="Greeting (after the AI and recording notice)" name="s_greeting" defaultValue={d.scripts.greeting} rows={2} />
        <TextArea label="Closing" name="s_closing" defaultValue={d.scripts.closing} rows={2} />
        <TextArea label="When handing to staff" name="s_transfer" defaultValue={d.scripts.transfer} rows={2} />
        <TextArea label="After hours" name="s_afterHours" defaultValue={d.scripts.afterHours} rows={2} />
        <h2 className="h2">Escalation</h2>
        <div className="row2">
          <TextArea label="Extra words that go to staff (one per line)" name="keywords" defaultValue={d.escalation.keywords.join("\n")} rows={3} />
          <Input label="Hand over after this many unclear turns" name="maxTurns" type="number" defaultValue={d.escalation.maxTurnsBeforeHandoff} />
        </div>
        <PermissionEditor legend="What this agent may do (never more than the clinic allows)" value={d.permissions} limits={clinic.permissions} />
        <Input label="What changed (for the history)" name="note" required={false} />
        <div className="form-actions">
          <Submit variant="ghost">Save draft</Submit>
          <Submit name="publish" value="1" pending="Publishing…">Save and publish</Submit>
        </div>
      </ActionForm>
    </>
  );
}
