// Authentication: clinic signup, login, sessions, password reset, staff invitations, deactivation.
// Framework-free so it can be tested directly; cookie handling lives in ./session-cookie.ts.

import { z } from "zod";
import { withContext, withoutUser, type DbContext } from "../db";
import { appBaseUrl } from "../env";
import { getEmailAdapter } from "../email";
import { TERMS_VERSION, TERMS_WORDING } from "../terms";
import { dummyPasswordHash, hashPassword, passwordProblem, verifyPassword } from "./password";
import { hashToken, newToken } from "./tokens";

export const SESSION_TTL_DAYS = 7;
export const RESET_TTL_MINUTES = 60;
export const INVITE_TTL_DAYS = 7;
export const MAX_FAILED_LOGINS = 5; // per email, in a rolling 15 minutes

export const CLINIC_TYPES = ["dental", "dermatology", "urology", "ent", "ophthalmology", "physiotherapy", "general", "diagnostic_centre", "other"] as const;
export const STAFF_ROLES = ["doctor", "receptionist", "clinic_manager"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type Role = "super_admin" | "clinic_admin" | StaffRole;

export interface SignedInUser {
  sessionId: string;
  userId: string;
  clinicId: string | null;
  role: Role;
  isSuperAdmin: boolean;
  displayName: string;
  email: string;
  clinicName: string | null;
  clinicStatus: "active" | "suspended" | null;
}

export function contextOf(u: SignedInUser): DbContext {
  return { userId: u.userId, clinicId: u.clinicId, isSuperAdmin: u.isSuperAdmin };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };
const fail = (error: string, field?: string): { ok: false; error: string; field?: string } => ({ ok: false, error, field });

const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(200);
const name = z.string().trim().min(2, "Enter a name.").max(120);

// ---------- signup ----------

export const signupSchema = z.object({
  clinicName: name,
  clinicType: z.enum(CLINIC_TYPES),
  city: z.string().trim().max(80).optional().default(""),
  phone: z.string().trim().regex(/^[0-9+\-\s]{7,20}$/, "Enter a valid phone number."),
  adminName: name,
  adminEmail: email,
  password: z.string(),
  acceptTerms: z.literal(true, { error: "Please accept the terms to continue." }),
});
export type SignupInput = z.input<typeof signupSchema>;

export async function signupClinic(input: SignupInput, ip: string | null): Promise<Result<{ clinicId: string; userId: string }>> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue.message, String(issue.path[0] ?? ""));
  }
  const d = parsed.data;
  const problem = passwordProblem(d.password);
  if (problem) return fail(problem, "password");
  const passwordHash = await hashPassword(d.password);
  try {
    const row = await withoutUser(async (c) => {
      const r = await c.query(
        "SELECT clinic_id, user_id FROM rc_signup_clinic($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [d.clinicName, d.clinicType, d.city || null, d.phone, d.adminName, d.adminEmail, passwordHash, TERMS_VERSION, TERMS_WORDING, ip],
      );
      return r.rows[0] as { clinic_id: string; user_id: string };
    });
    return { ok: true, value: { clinicId: row.clinic_id, userId: row.user_id } };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return fail("An account with this email already exists. Try signing in.", "adminEmail");
    throw err;
  }
}

// ---------- login / sessions ----------

export async function login(
  rawEmail: string,
  password: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<Result<{ token: string; expiresAt: Date }>> {
  const parsedEmail = email.safeParse(rawEmail);
  const genericError = "That email and password don't match. Check them and try again.";
  if (!parsedEmail.success || !password) return fail(genericError);
  const e = parsedEmail.data;

  return withoutUser(async (c) => {
    const r = await c.query("SELECT * FROM rc_auth_lookup($1)", [e]);
    const row = r.rows[0] as
      | { user_id: string; password_hash: string | null; user_status: string; clinic_status: string | null; role: Role; recent_failures: number }
      | undefined;

    const failures = row?.recent_failures ?? (await c.query("SELECT rc_auth_recent_failures($1) AS n", [e])).rows[0].n;
    if (failures >= MAX_FAILED_LOGINS) {
      return fail("Too many attempts. Wait 15 minutes, or reset your password.");
    }

    const ok = await verifyPassword(password, row?.password_hash ?? (await dummyPasswordHash()));
    if (!row || !row.password_hash || !ok) {
      await c.query("SELECT rc_auth_record_attempt($1,$2,false)", [e, meta.ip]);
      return fail(genericError);
    }
    if (row.user_status !== "active") {
      return fail("This account has been switched off. Ask your clinic admin.");
    }
    if (row.role !== "super_admin" && row.clinic_status !== "active") {
      return fail("This clinic's RedClinic account is paused. Please contact RedClinic.");
    }

    await c.query("SELECT rc_auth_record_attempt($1,$2,true)", [e, meta.ip]);
    const token = newToken();
    await c.query("SELECT rc_session_create($1,$2,$3::interval,$4,$5)", [
      row.user_id, hashToken(token), `${SESSION_TTL_DAYS} days`, meta.ip, meta.userAgent,
    ]);
    return { ok: true as const, value: { token, expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000) } };
  });
}

export async function resolveSession(token: string | undefined | null): Promise<SignedInUser | null> {
  if (!token || token.length > 200) return null;
  return withoutUser(async (c) => {
    const r = await c.query("SELECT * FROM rc_session_resolve($1)", [hashToken(token)]);
    const s = r.rows[0];
    if (!s) return null;
    return {
      sessionId: s.session_id,
      userId: s.user_id,
      clinicId: s.clinic_id,
      role: s.role,
      isSuperAdmin: s.is_super,
      displayName: s.display_name,
      email: s.email,
      clinicName: s.clinic_name,
      clinicStatus: s.clinic_status,
    };
  });
}

export async function logout(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await withoutUser((c) => c.query("SELECT rc_session_revoke($1)", [hashToken(token)]));
}

// ---------- password reset ----------

/** Always reports success to the caller, so it cannot be used to find out which emails have accounts. */
export async function requestPasswordReset(rawEmail: string): Promise<void> {
  const parsed = email.safeParse(rawEmail);
  if (!parsed.success) return;
  const token = newToken();
  const row = await withoutUser(async (c) => {
    const r = await c.query("SELECT * FROM rc_reset_token_create($1,$2,$3::interval)", [
      parsed.data, hashToken(token), `${RESET_TTL_MINUTES} minutes`,
    ]);
    return r.rows[0] as { display_name: string; email: string } | undefined;
  });
  if (!row) return;
  await getEmailAdapter().send({
    to: row.email,
    subject: "Reset your RedClinic password",
    text:
      `Hi ${row.display_name},\n\nUse this link to choose a new password. It works once and expires in ${RESET_TTL_MINUTES} minutes:\n` +
      `${appBaseUrl()}/set-password?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
  });
}

export async function checkSetPasswordToken(token: string): Promise<{ purpose: "reset" | "invite"; email: string; displayName: string } | null> {
  if (!token || token.length > 200) return null;
  return withoutUser(async (c) => {
    const r = await c.query("SELECT * FROM rc_auth_token_peek($1)", [hashToken(token)]);
    const t = r.rows[0];
    return t ? { purpose: t.purpose, email: t.email, displayName: t.display_name } : null;
  });
}

/** Sets a password from a reset or invitation link. Signs the user out of every other session. */
export async function setPasswordWithToken(token: string, password: string): Promise<Result<{ userId: string }>> {
  const problem = passwordProblem(password);
  if (problem) return fail(problem, "password");
  if (!token || token.length > 200) return fail("This link is not valid. Ask for a new one.");
  const passwordHash = await hashPassword(password);
  const userId = await withoutUser(async (c) => {
    const r = await c.query("SELECT rc_auth_token_consume($1,$2) AS user_id", [hashToken(token), passwordHash]);
    return r.rows[0].user_id as string | null;
  });
  if (!userId) return fail("This link has expired or was already used. Ask for a new one.");
  return { ok: true, value: { userId } };
}

// ---------- staff (used by the clinic admin) ----------

export const inviteSchema = z.object({
  displayName: name,
  email,
  role: z.enum(STAFF_ROLES),
});

/**
 * Creates a staff account with the role's default permissions and emails a link to choose a password.
 * Row-level security and rc_invite_token_create both require manage_staff in the actor's clinic.
 */
export async function inviteStaff(actor: SignedInUser, input: z.input<typeof inviteSchema>): Promise<Result<{ userId: string }>> {
  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, String(parsed.error.issues[0].path[0] ?? ""));
  if (!actor.clinicId) return fail("Choose a clinic first.");
  const d = parsed.data;
  const token = newToken();
  try {
    const userId = await withContext(contextOf(actor), async (c) => {
      const allowed = (await c.query("SELECT rc_has_capability('manage_staff') AS ok")).rows[0].ok;
      if (!allowed) throw new PermissionError();
      const r = await c.query(
        "INSERT INTO users (clinic_id, role, email, display_name) VALUES ($1,$2,$3,$4) RETURNING id",
        [actor.clinicId, d.role, d.email, d.displayName],
      );
      const id = r.rows[0].id as string;
      await c.query("SELECT rc_apply_role_preset($1,$2)", [id, actor.userId]);
      await c.query("SELECT rc_invite_token_create($1,$2,$3::interval)", [id, hashToken(token), `${INVITE_TTL_DAYS} days`]);
      return id;
    });
    await getEmailAdapter().send({
      to: d.email,
      subject: `${actor.clinicName ?? "Your clinic"} has added you to RedClinic`,
      text:
        `Hi ${d.displayName},\n\n${actor.displayName} has added you to ${actor.clinicName ?? "their clinic"} on RedClinic.\n` +
        `Choose your password here (the link expires in ${INVITE_TTL_DAYS} days):\n${appBaseUrl()}/set-password?token=${token}`,
    });
    return { ok: true, value: { userId } };
  } catch (err) {
    if (err instanceof PermissionError) return fail("You don't have permission to add staff.");
    if ((err as { code?: string }).code === "23505") return fail("Someone with this email already has a RedClinic account.", "email");
    throw err;
  }
}

/** Switches a staff account off. Their sessions end immediately (database trigger). */
export async function deactivateUser(actor: SignedInUser, userId: string): Promise<Result<null>> {
  if (userId === actor.userId) return fail("You can't switch off your own account.");
  const n = await withContext(contextOf(actor), async (c) => {
    const r = await c.query(
      "UPDATE users SET status = 'deactivated' WHERE id = $1 AND status = 'active' AND role <> 'clinic_admin' RETURNING clinic_id",
      [userId],
    );
    if (r.rowCount) {
      await c.query(
        "INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id) VALUES ($1,$2,$3,'user_deactivated','user',$4)",
        [r.rows[0].clinic_id, actor.userId, actor.isSuperAdmin, userId],
      );
    }
    return r.rowCount ?? 0;
  });
  return n ? { ok: true, value: null } : fail("You can't switch off this account.");
}

class PermissionError extends Error {}
