import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, getPool, withContext, withoutUser } from "@/lib/db";
import {
  checkSetPasswordToken, contextOf, deactivateUser, inviteStaff, login, logout, MAX_FAILED_LOGINS,
  requestPasswordReset, resolveSession, setPasswordWithToken, signupClinic,
} from "@/lib/auth/service";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { freshOutbox, linkToken, newClinic, PASSWORD, signIn, uniqueEmail } from "./helpers";

const meta = { ip: "127.0.0.1", userAgent: "vitest" };
let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
afterAll(closePool);

describe("connection role", () => {
  it("the app does not connect as a superuser or the table owner", async () => {
    const r = await getPool().query("SELECT rolsuper, current_user FROM pg_roles WHERE rolname = current_user");
    expect(r.rows[0].rolsuper).toBe(false);
    expect(r.rows[0].current_user).not.toBe("postgres");
  });

  it("cannot read auth tables directly", async () => {
    for (const t of ["user_credentials", "sessions", "auth_tokens", "login_attempts"]) {
      await expect(getPool().query(`SELECT * FROM ${t}`)).rejects.toThrow(/permission denied/);
    }
  });

  it("sees no clinic data without a signed-in user", async () => {
    await newClinic();
    const n = await withoutUser(async (c) => (await c.query("SELECT count(*)::int AS n FROM clinics")).rows[0].n);
    expect(n).toBe(0);
  });
});

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword("wrong password!", a)).toBe(false);
    expect(await verifyPassword(PASSWORD, "garbage")).toBe(false);
  });
});

describe("clinic signup", () => {
  it("creates clinic, clinic admin, terms acceptance and installs the Dental Pack", async () => {
    const { admin, clinicId } = await newClinic("dental");
    expect(admin.role).toBe("clinic_admin");
    expect(admin.clinicId).toBe(clinicId);
    await withContext(contextOf(admin), async (c) => {
      const terms = await c.query("SELECT terms_version, wording, ip FROM terms_acceptances");
      expect(terms.rowCount).toBe(1);
      expect(terms.rows[0].ip).toBe("127.0.0.1");
      expect(terms.rows[0].wording.length).toBeGreaterThan(50);
      const wf = await c.query("SELECT count(*)::int AS n FROM clinic_workflows");
      expect(wf.rows[0].n).toBeGreaterThan(0);
      const audit = await c.query("SELECT action FROM audit_log WHERE action = 'clinic_signup'");
      expect(audit.rowCount).toBe(1);
    });
  });

  it("rejects a duplicate email in any letter case", async () => {
    const { adminEmail } = await newClinic();
    const r = await signupClinic(
      { clinicName: "Other", clinicType: "dental", phone: "9800000001", adminName: "X Y", adminEmail: adminEmail.toUpperCase(), password: PASSWORD, acceptTerms: true },
      null,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("adminEmail");
  });

  it("requires terms, a valid email and a strong enough password", async () => {
    const base = { clinicName: "C", clinicType: "dental" as const, phone: "9800000002", adminName: "Ad Min", password: PASSWORD };
    expect((await signupClinic({ ...base, clinicName: "Clinic", adminEmail: uniqueEmail(), acceptTerms: false as unknown as true }, null)).ok).toBe(false);
    expect((await signupClinic({ ...base, clinicName: "Clinic", adminEmail: "not-an-email", acceptTerms: true }, null)).ok).toBe(false);
    const weak = await signupClinic({ ...base, clinicName: "Clinic", adminEmail: uniqueEmail(), password: "short", acceptTerms: true }, null);
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.field).toBe("password");
  });
});

describe("login and sessions", () => {
  it("logs in case-insensitively and resolves the session", async () => {
    const { adminEmail } = await newClinic();
    const r = await login(adminEmail.toUpperCase(), PASSWORD, meta);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = await resolveSession(r.value.token);
    expect(u?.email).toBe(adminEmail);
  });

  it("gives the same message for a wrong password and an unknown email", async () => {
    const { adminEmail } = await newClinic();
    const a = await login(adminEmail, "wrong password here", meta);
    const b = await login(uniqueEmail("nobody"), "wrong password here", meta);
    expect(a.ok || b.ok).toBe(false);
    if (!a.ok && !b.ok) expect(a.error).toBe(b.error);
  });

  it("locks the email after repeated failures, even with the right password", async () => {
    const { adminEmail } = await newClinic();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) await login(adminEmail, "wrong password here", meta);
    const r = await login(adminEmail, PASSWORD, meta);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Too many attempts/);
  });

  it("rejects unknown, tampered and logged-out tokens", async () => {
    const { token } = await newClinic();
    expect(await resolveSession("nonsense")).toBeNull();
    expect(await resolveSession(token.slice(0, -2) + "xx")).toBeNull();
    expect(await resolveSession(token)).not.toBeNull();
    await logout(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it("expired sessions do not resolve", async () => {
    const { token } = await newClinic();
    const admin = await adminPool();
    await admin.query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    expect(await resolveSession(token)).toBeNull();
  });

  it("a suspended clinic cannot log in, and existing sessions see no clinic data", async () => {
    const { adminEmail, clinicId, token } = await newClinic();
    const admin = await adminPool();
    await admin.query("UPDATE clinics SET status = 'suspended' WHERE id = $1", [clinicId]);
    const r = await login(adminEmail, PASSWORD, meta);
    expect(r.ok).toBe(false);
    const u = await resolveSession(token);
    expect(u?.clinicStatus).toBe("suspended");
    const n = await withContext(contextOf(u!), async (c) => (await c.query("SELECT count(*)::int AS n FROM clinic_workflows")).rows[0].n);
    expect(n).toBe(0);
  });
});

describe("password reset", () => {
  it("emails a one-time link that sets a new password and ends old sessions", async () => {
    const { adminEmail, token: oldSession } = await newClinic();
    await requestPasswordReset(adminEmail);
    expect(outbox.outbox).toHaveLength(1);
    const t = linkToken(outbox.outbox[0].text);
    expect((await checkSetPasswordToken(t))?.purpose).toBe("reset");

    const r = await setPasswordWithToken(t, "a brand new password");
    expect(r.ok).toBe(true);
    expect(await resolveSession(oldSession)).toBeNull();
    expect((await login(adminEmail, PASSWORD, meta)).ok).toBe(false);
    expect((await login(adminEmail, "a brand new password", meta)).ok).toBe(true);
    expect((await setPasswordWithToken(t, "another new password")).ok).toBe(false); // used once only
  });

  it("does nothing visible for an unknown email", async () => {
    await requestPasswordReset(uniqueEmail("ghost"));
    expect(outbox.outbox).toHaveLength(0);
  });

  it("only the newest reset link works", async () => {
    const { adminEmail } = await newClinic();
    await requestPasswordReset(adminEmail);
    await requestPasswordReset(adminEmail);
    const [first, second] = outbox.outbox.map((m) => linkToken(m.text));
    expect(await checkSetPasswordToken(first)).toBeNull();
    expect(await checkSetPasswordToken(second)).not.toBeNull();
  });

  it("expired links are refused", async () => {
    const { adminEmail } = await newClinic();
    await requestPasswordReset(adminEmail);
    const t = linkToken(outbox.outbox[0].text);
    await (await adminPool()).query("UPDATE auth_tokens SET expires_at = now() - interval '1 second'");
    expect((await setPasswordWithToken(t, "a brand new password")).ok).toBe(false);
  });
});

describe("staff invitations and deactivation", () => {
  it("clinic admin invites a receptionist who sets a password and gets the role preset", async () => {
    const { admin } = await newClinic();
    const email = uniqueEmail("recep");
    const r = await inviteStaff(admin, { displayName: "Priya R", email, role: "receptionist" });
    expect(r.ok).toBe(true);
    expect((await login(email, PASSWORD, meta)).ok).toBe(false); // no password yet

    const t = linkToken(outbox.outbox[0].text);
    expect((await checkSetPasswordToken(t))?.purpose).toBe("invite");
    expect((await setPasswordWithToken(t, PASSWORD)).ok).toBe(true);
    const { user } = await signIn(email);
    expect(user.role).toBe("receptionist");
    expect(user.clinicId).toBe(admin.clinicId);
    const caps = await withContext(contextOf(user), async (c) => ({
      manageAppointments: (await c.query("SELECT rc_has_capability('manage_appointments') AS ok")).rows[0].ok,
      history: (await c.query("SELECT rc_has_capability('view_patient_history') AS ok")).rows[0].ok,
    }));
    expect(caps).toEqual({ manageAppointments: true, history: false });
  });

  it("staff without manage_staff cannot invite", async () => {
    const { admin } = await newClinic();
    const email = uniqueEmail("doc");
    await inviteStaff(admin, { displayName: "Dr Rao", email, role: "doctor" });
    await setPasswordWithToken(linkToken(outbox.outbox[0].text), PASSWORD);
    const { user: doctor } = await signIn(email);
    const r = await inviteStaff(doctor, { displayName: "Sneaky", email: uniqueEmail(), role: "receptionist" });
    expect(r.ok).toBe(false);
  });

  it("a clinic admin cannot invite into, or switch off users of, another clinic", async () => {
    const a = await newClinic();
    const b = await newClinic();
    const email = uniqueEmail("b-recep");
    await inviteStaff(b.admin, { displayName: "B Recep", email, role: "receptionist" });
    const bUser = await withContext(contextOf(b.admin), async (c) => (await c.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id);
    expect((await deactivateUser(a.admin, bUser)).ok).toBe(false);
    // and the invite function itself refuses cross-clinic use
    await expect(withContext(contextOf(a.admin), (c) => c.query("SELECT rc_invite_token_create($1, '\\x00'::bytea, '1 day')", [bUser]))).rejects.toThrow(/not allowed/);
  });

  it("deactivation ends the user's sessions immediately and blocks login", async () => {
    const { admin } = await newClinic();
    const email = uniqueEmail("leaver");
    const inv = await inviteStaff(admin, { displayName: "Leaver", email, role: "receptionist" });
    await setPasswordWithToken(linkToken(outbox.outbox[0].text), PASSWORD);
    const { token } = await signIn(email);
    expect(inv.ok && (await deactivateUser(admin, inv.value.userId)).ok).toBe(true);
    expect(await resolveSession(token)).toBeNull();
    const r = await login(email, PASSWORD, meta);
    expect(r.ok).toBe(false);
    // a reset link cannot revive the account
    await requestPasswordReset(email);
    expect(outbox.outbox.filter((m) => m.to === email && /Reset/.test(m.subject))).toHaveLength(0);
  });

  it("the clinic admin cannot switch off their own account", async () => {
    const { admin } = await newClinic();
    expect((await deactivateUser(admin, admin.userId)).ok).toBe(false);
  });
});

// Owner connection for test setup only (simulating expiry, suspension by super admin).
import { Pool } from "pg";
import { userInfo } from "node:os";
let ownerPool: Pool | undefined;
async function adminPool(): Promise<Pool> {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  ownerPool ??= url
    ? new Pool({ connectionString: url.replace(/\/[^/]*$/, "/rc_vitest") })
    : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
  return ownerPool;
}
afterAll(async () => { await ownerPool?.end(); });
