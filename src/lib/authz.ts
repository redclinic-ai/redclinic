// Shared helpers for services: run as the signed-in user, check capabilities, turn known errors into messages.
import type { PoolClient } from "pg";
import { withContext } from "./db";
import { contextOf, type Result, type SignedInUser } from "./auth/service";

export class Denied extends Error {
  constructor(message = "You don't have permission to do that.") { super(message); }
}
export class UserError extends Error {
  constructor(message: string, public field?: string) { super(message); }
}

export async function can(c: PoolClient, cap: string): Promise<boolean> {
  return (await c.query("SELECT rc_has_capability($1) AS ok", [cap])).rows[0].ok;
}

export async function requireCap(c: PoolClient, cap: string, message?: string): Promise<void> {
  if (!(await can(c, cap))) throw new Denied(message);
}

/** Runs fn in the actor's context and converts Denied/UserError (and a few database errors) into a failed Result. */
export async function act<T>(actor: SignedInUser, fn: (c: PoolClient) => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await withContext(contextOf(actor), fn) };
  } catch (err) {
    if (err instanceof Denied) return { ok: false, error: err.message };
    if (err instanceof UserError) return { ok: false, error: err.message, field: err.field };
    const code = (err as { code?: string }).code;
    if (code === "42501") return { ok: false, error: "You don't have permission to do that." }; // RLS refusal
    if (code === "23P01") return { ok: false, error: "That doctor already has an appointment at this time. Choose another time.", field: "time" };
    throw err;
  }
}

export async function audit(c: PoolClient, actor: SignedInUser, action: string, entity: string, entityId: string, detail: object = {}) {
  await c.query(
    "INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [actor.clinicId, actor.userId, actor.isSuperAdmin, action, entity, entityId, detail],
  );
}

export const firstIssue = (e: { issues: { message: string; path: PropertyKey[] }[] }) =>
  new UserError(e.issues[0].message, String(e.issues[0].path[0] ?? ""));
