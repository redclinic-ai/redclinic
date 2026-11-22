// Layer 1: RedClinic global policies. Only the super admin changes them; every clinic and agent inherits them.
import { z } from "zod";
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, audit, UserError } from "../authz";

export interface Policy {
  policyId: string; key: string; category: string; priority: 1 | 2; versionId: string; version: number;
  title: string; ruleText: string; mandatory: boolean; active: boolean; effectiveFrom: Date; effectiveTo: Date | null;
}

const CURRENT = `
  SELECT p.id AS policy_id, p.key, p.category, p.priority, v.id AS version_id, v.version, v.title, v.rule_text, v.mandatory, v.active,
         v.effective_from, v.effective_to
  FROM global_policies p JOIN global_policy_current cur ON cur.policy_id = p.id JOIN global_policy_versions v ON v.id = cur.version_id`;

const toPolicy = (x: Record<string, any>): Policy => ({
  policyId: x.policy_id, key: x.key, category: x.category, priority: x.priority, versionId: x.version_id, version: x.version,
  title: x.title, ruleText: x.rule_text, mandatory: x.mandatory, active: x.active, effectiveFrom: x.effective_from, effectiveTo: x.effective_to,
});

/** Policies in force right now (active and within their dates), legal/safety first. */
export async function activePolicies(c: PoolClient, at = new Date()): Promise<Policy[]> {
  const r = await c.query(`${CURRENT} WHERE v.active AND v.effective_from <= $1 AND (v.effective_to IS NULL OR v.effective_to > $1) ORDER BY p.priority, p.category, p.key`, [at]);
  return r.rows.map(toPolicy);
}

export async function listPolicies(actor: SignedInUser) {
  return act(actor, async (c) => (await c.query(`${CURRENT} ORDER BY p.priority, p.category, p.key`)).rows.map(toPolicy));
}

export async function policyHistory(actor: SignedInUser, policyId: string) {
  return act(actor, async (c) => {
    const r = await c.query(
      `SELECT v.*, u.display_name AS by, (cur.version_id = v.id) AS is_current FROM global_policy_versions v
       LEFT JOIN users u ON u.id = v.created_by LEFT JOIN global_policy_current cur ON cur.policy_id = v.policy_id
       WHERE v.policy_id = $1 ORDER BY v.version DESC`, [policyId]);
    return r.rows.map((x) => ({ id: x.id, version: x.version, title: x.title, ruleText: x.rule_text, mandatory: x.mandatory, active: x.active,
      effectiveFrom: x.effective_from, effectiveTo: x.effective_to, note: x.change_note, by: x.by, createdAt: x.created_at, isCurrent: x.is_current }));
  });
}

const versionSchema = z.object({
  title: z.string().trim().min(3).max(120),
  ruleText: z.string().trim().min(10).max(2000),
  mandatory: z.boolean(),
  active: z.boolean(),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  note: z.string().trim().min(3, "Say why you are changing this policy.").max(500),
});

function requireSuper(actor: SignedInUser) {
  if (!actor.isSuperAdmin) throw new UserError("Only RedClinic can change global policies.");
}

/** Saves a new version of an existing policy and makes it current. */
export async function updatePolicy(actor: SignedInUser, policyId: string, input: z.input<typeof versionSchema>) {
  return act(actor, async (c) => {
    requireSuper(actor);
    const p = versionSchema.safeParse(input);
    if (!p.success) throw new UserError(p.error.issues[0].message, String(p.error.issues[0].path[0]));
    const d = p.data;
    const cur = (await c.query(`${CURRENT} WHERE p.id = $1`, [policyId])).rows[0];
    if (!cur) throw new UserError("Policy not found.");
    if (cur.priority === 1 && (!d.mandatory || !d.active)) {
      throw new UserError("Legal, privacy and safety policies must stay mandatory and active. Edit the wording instead.");
    }
    const next = (await c.query("SELECT max(version)+1 AS v FROM global_policy_versions WHERE policy_id = $1", [policyId])).rows[0].v;
    const v = await c.query(
      `INSERT INTO global_policy_versions (policy_id, version, title, rule_text, mandatory, active, effective_from, effective_to, change_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,coalesce($7, now()),$8,$9,$10) RETURNING id`,
      [policyId, next, d.title, d.ruleText, d.mandatory, d.active, d.effectiveFrom ?? null, d.effectiveTo ?? null, d.note, actor.userId]);
    await c.query("UPDATE global_policy_current SET version_id = $2 WHERE policy_id = $1", [policyId, v.rows[0].id]);
    await audit(c, actor, "global_policy_updated", "global_policy", policyId, { version: next, note: d.note });
    return next as number;
  });
}

export async function createPolicy(actor: SignedInUser, input: z.input<typeof versionSchema> & { key: string; category: string }) {
  return act(actor, async (c) => {
    requireSuper(actor);
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (key.length < 3) throw new UserError("Give the policy a short key.", "key");
    const p = versionSchema.safeParse(input);
    if (!p.success) throw new UserError(p.error.issues[0].message);
    const category = z.enum(["legal", "privacy", "safety", "behaviour", "quality"]).safeParse(input.category);
    if (!category.success) throw new UserError("Choose a category.", "category");
    const priority = ["legal", "privacy", "safety"].includes(category.data) ? 1 : 2;
    try {
      const pol = await c.query("INSERT INTO global_policies (key, category, priority) VALUES ($1,$2,$3) RETURNING id", [key, category.data, priority]);
      const d = p.data;
      const v = await c.query(
        `INSERT INTO global_policy_versions (policy_id, version, title, rule_text, mandatory, active, effective_from, effective_to, change_note, created_by)
         VALUES ($1,1,$2,$3,$4,$5,coalesce($6, now()),$7,$8,$9) RETURNING id`,
        [pol.rows[0].id, d.title, d.ruleText, priority === 1 ? true : d.mandatory, d.active, d.effectiveFrom ?? null, d.effectiveTo ?? null, d.note, actor.userId]);
      await c.query("INSERT INTO global_policy_current VALUES ($1,$2)", [pol.rows[0].id, v.rows[0].id]);
      await audit(c, actor, "global_policy_created", "global_policy", pol.rows[0].id, { key });
      return pol.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new UserError("A policy with this key exists.", "key");
      throw e;
    }
  });
}

/** Rollback: makes an older version current again. */
export async function rollbackPolicy(actor: SignedInUser, policyId: string, versionId: string) {
  return act(actor, async (c) => {
    requireSuper(actor);
    const v = (await c.query("SELECT v.*, p.priority FROM global_policy_versions v JOIN global_policies p ON p.id = v.policy_id WHERE v.id = $1 AND v.policy_id = $2", [versionId, policyId])).rows[0];
    if (!v) throw new UserError("Version not found.");
    await c.query("UPDATE global_policy_current SET version_id = $2 WHERE policy_id = $1", [policyId, versionId]);
    await audit(c, actor, "global_policy_rolled_back", "global_policy", policyId, { to_version: v.version });
    return v.version as number;
  });
}

export async function policyTests(c: PoolClient) {
  const r = await c.query("SELECT t.id, t.caller_says, t.expect, p.key FROM global_policy_tests t JOIN global_policies p ON p.id = t.policy_id ORDER BY p.priority, p.key");
  return r.rows.map((x) => ({ id: x.id as string, says: x.caller_says as string, expect: x.expect as string, policyKey: x.key as string }));
}
