// Clinic-level and agent-level NEPA configuration: versioned, edited as a draft, then published. Rollback publishes
// a copy of an older version, so history only ever grows.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, requireCap, UserError } from "../authz";
import { ACTIONS, clampPermissions, MODES, type Mode } from "./permissions";

const mode = z.enum(MODES);
const perms = z.record(z.string(), mode).default({}).transform((p) => clampPermissions(p).permissions);
const lang = z.enum(["en", "hi", "kn"]);

export const clinicConfigSchema = z.object({
  greeting: z.object({ en: z.string().max(400), hi: z.string().max(400), kn: z.string().max(400) }).partial().default({}),
  tone: z.enum(["warm", "formal", "friendly"]).default("warm"),
  personality: z.string().max(400).default(""),
  preferredLanguage: lang.default("en"),
  languageSwitching: z.boolean().default(true),
  appointmentPolicy: z.string().max(1500).default(""),
  instructions: z.string().max(3000).default(""),
  escalation: z.object({ fallbackNumber: z.string().max(20).default(""), keywords: z.array(z.string().max(40)).max(30).default([]) }).default({ fallbackNumber: "", keywords: [] }),
  permissions: perms,
});
export type ClinicConfig = z.infer<typeof clinicConfigSchema>;

export const agentConfigSchema = z.object({
  name: z.string().trim().min(1).max(40).default("Nepa"),
  objective: z.string().max(500).default(""),
  voice: z.object({ provider: z.string().default("cartesia"), voiceId: z.string().max(100).default("") }).default({ provider: "cartesia", voiceId: "" }),
  languages: z.array(lang).min(1).default(["en", "hi", "kn"]),
  personality: z.string().max(400).default(""),
  scripts: z.object({
    greeting: z.string().max(500).default(""), closing: z.string().max(500).default(""),
    transfer: z.string().max(500).default(""), afterHours: z.string().max(500).default(""),
  }).partial().default({}),
  knowledgeScope: z.enum(["all", "faq_only", "none"]).default("all"),
  workflowIds: z.array(z.string().uuid()).default([]),
  operatingHours: z.enum(["clinic", "always", "after_hours_only"]).default("clinic"),
  permissions: perms,
  escalation: z.object({ keywords: z.array(z.string().max(40)).max(30).default([]), maxTurnsBeforeHandoff: z.number().int().min(2).max(30).default(12) }).default({ keywords: [], maxTurnsBeforeHandoff: 12 }),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const AGENT_DEFAULTS: Record<string, Partial<AgentConfig>> = {
  receptionist: { name: "Nepa", objective: "Answer calls, answer questions from the clinic's approved list, take appointment requests and hand anything else to staff." },
  reminder: { name: "Nepa", objective: "Call patients before appointments to confirm they are coming.", knowledgeScope: "faq_only" },
  lead_followup: { name: "Nepa", objective: "Call back people who enquired but did not book, and offer an appointment." },
  feedback: { name: "Nepa", objective: "Call patients after treatment to ask how they are and pass any problem to staff.", knowledgeScope: "none" },
};
export const AGENT_LABEL: Record<string, string> = { receptionist: "Receptionist", reminder: "Appointment reminders", lead_followup: "Enquiry follow-up", feedback: "After-treatment check-in" };

export interface ConfigVersion<T> { id: string; version: number; status: "draft" | "published" | "archived"; data: T; changeNote: string | null; createdAt: Date; createdBy: string | null; publishedAt: Date | null }

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new UserError(r.error.issues[0].message);
  return r.data;
}

async function versions(c: PoolClient, agentId: string | null) {
  const r = await c.query(
    `SELECT v.*, u.display_name FROM nepa_config_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE ${agentId ? "v.agent_id = $1" : "v.agent_id IS NULL AND $1::uuid IS NULL"} ORDER BY v.version DESC`, [agentId]);
  return r.rows;
}

/** Published and draft versions for the clinic layer (agentId null) or one agent. */
export async function getConfig(c: PoolClient, agentId: string | null, kind?: string) {
  const rows = await versions(c, agentId);
  const schema = agentId ? agentConfigSchema : clinicConfigSchema;
  const toV = (x: Record<string, any>) => ({ id: x.id, version: x.version, status: x.status, data: parse(schema as z.ZodType<any>, x.data), changeNote: x.change_note, createdAt: x.created_at, createdBy: x.display_name, publishedAt: x.published_at });
  const published = rows.find((x) => x.status === "published");
  const draft = rows.find((x) => x.status === "draft");
  const defaults = parse(schema as z.ZodType<any>, agentId ? AGENT_DEFAULTS[kind ?? "receptionist"] ?? {} : {});
  return {
    published: published ? toV(published) : null,
    draft: draft ? toV(draft) : null,
    effective: (published ? toV(published).data : defaults),
    history: rows.filter((x) => x.status !== "draft").map(toV),
  };
}

async function checkAgent(c: PoolClient, agentId: string | null) {
  if (!agentId) return null;
  const a = (await c.query("SELECT id, kind FROM nepa_agents WHERE id = $1", [agentId])).rows[0];
  if (!a) throw new UserError("Agent not found.");
  return a.kind as string;
}

export async function saveDraft(actor: SignedInUser, agentId: string | null, data: unknown, note?: string) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow", "You don't have permission to change NEPA settings.");
    await checkAgent(c, agentId);
    const schema = agentId ? agentConfigSchema : clinicConfigSchema;
    const raw = (data ?? {}) as { permissions?: Record<string, string> };
    const clean = parse(schema as z.ZodType<any>, data);
    // agent permissions can never be looser than the clinic's
    let clamped: ReturnType<typeof clampPermissions>["clamped"] = [];
    if (agentId) {
      const clinic = await getConfig(c, null);
      const r = clampPermissions(raw.permissions ?? {}, (clinic.effective as ClinicConfig).permissions);
      clean.permissions = r.permissions; clamped = r.clamped;
    } else {
      clamped = clampPermissions(raw.permissions ?? {}).clamped;
    }
    const existing = (await versions(c, agentId)).find((x) => x.status === "draft");
    if (existing) {
      await c.query("UPDATE nepa_config_versions SET data = $2, change_note = $3, created_by = $4, created_at = now() WHERE id = $1", [existing.id, clean, note ?? null, actor.userId]);
    } else {
      const next = (await c.query(
        `SELECT coalesce(max(version),0)+1 AS v FROM nepa_config_versions WHERE ${agentId ? "agent_id = $1" : "agent_id IS NULL AND $1::uuid IS NULL"}`, [agentId])).rows[0].v;
      await c.query("INSERT INTO nepa_config_versions (clinic_id, agent_id, version, status, data, change_note, created_by) VALUES ($1,$2,$3,'draft',$4,$5,$6)",
        [actor.clinicId, agentId, next, clean, note ?? null, actor.userId]);
    }
    await audit(c, actor, "nepa_config_draft_saved", agentId ? "nepa_agent" : "clinic", agentId ?? actor.clinicId!);
    return { clamped };
  });
}

export async function publishDraft(actor: SignedInUser, agentId: string | null) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    await checkAgent(c, agentId);
    const rows = await versions(c, agentId);
    const draft = rows.find((x) => x.status === "draft");
    if (!draft) throw new UserError("There are no unpublished changes.");
    await c.query(`UPDATE nepa_config_versions SET status='archived' WHERE status='published' AND ${agentId ? "agent_id = $1" : "agent_id IS NULL AND $1::uuid IS NULL"}`, [agentId]);
    await c.query("UPDATE nepa_config_versions SET status='published', published_by=$2, published_at=now() WHERE id=$1", [draft.id, actor.userId]);
    await audit(c, actor, "nepa_config_published", agentId ? "nepa_agent" : "clinic", agentId ?? actor.clinicId!, { version: draft.version });
    return draft.version as number;
  });
}

export async function discardDraft(actor: SignedInUser, agentId: string | null) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    await c.query(`DELETE FROM nepa_config_versions WHERE status='draft' AND ${agentId ? "agent_id = $1" : "agent_id IS NULL AND $1::uuid IS NULL"}`, [agentId]);
    return null;
  });
}

/** Rollback: publishes a new version whose content is a copy of an older one. */
export async function rollbackTo(actor: SignedInUser, agentId: string | null, version: number) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    await checkAgent(c, agentId);
    const rows = await versions(c, agentId);
    const old = rows.find((x) => x.version === version && x.status !== "draft");
    if (!old) throw new UserError("Version not found.");
    await c.query(`DELETE FROM nepa_config_versions WHERE status='draft' AND ${agentId ? "agent_id = $1" : "agent_id IS NULL AND $1::uuid IS NULL"}`, [agentId]);
    await c.query(`UPDATE nepa_config_versions SET status='archived' WHERE status='published' AND ${agentId ? "agent_id = $1" : "agent_id IS NULL AND $1::uuid IS NULL"}`, [agentId]);
    const next = Math.max(...rows.map((x) => x.version)) + 1;
    await c.query(
      "INSERT INTO nepa_config_versions (clinic_id, agent_id, version, status, data, change_note, created_by, published_by, published_at) VALUES ($1,$2,$3,'published',$4,$5,$6,$6,now())",
      [actor.clinicId, agentId, next, old.data, `Restored version ${version}`, actor.userId]);
    await audit(c, actor, "nepa_config_rolled_back", agentId ? "nepa_agent" : "clinic", agentId ?? actor.clinicId!, { to: version, new_version: next });
    return next;
  });
}

export async function listAgents(actor: SignedInUser) {
  return act(actor, async (c) => {
    const r = await c.query("SELECT * FROM nepa_agents ORDER BY array_position(ARRAY['receptionist','reminder','lead_followup','feedback'], kind)");
    return r.rows.map((x) => ({ id: x.id as string, kind: x.kind as string, label: AGENT_LABEL[x.kind], enabled: x.enabled as boolean }));
  });
}

export async function setAgentEnabled(actor: SignedInUser, agentId: string, enabled: boolean) {
  return act(actor, async (c) => {
    await requireCap(c, "edit_workflow");
    if (enabled) {
      const kind = (await c.query("SELECT kind FROM nepa_agents WHERE id = $1", [agentId])).rows[0]?.kind;
      const feature = kind === "receptionist" ? "nepa_inbound" : "nepa_outbound";
      if (kind && !(await c.query("SELECT rc_feature_enabled($1) AS on", [feature])).rows[0].on) throw new UserError("RedClinic has switched this off for your clinic. Please contact RedClinic.");
    }
    const r = await c.query("UPDATE nepa_agents SET enabled = $2 WHERE id = $1", [agentId, enabled]);
    if (!r.rowCount) throw new UserError("Agent not found.");
    await audit(c, actor, enabled ? "nepa_agent_enabled" : "nepa_agent_disabled", "nepa_agent", agentId);
    return null;
  });
}

export { ACTIONS, type Mode };
