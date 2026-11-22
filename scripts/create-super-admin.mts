// Creates (or resets the password of) a RedClinic super admin. Run by an operator with the owner connection:
//   DATABASE_ADMIN_URL=... SUPER_ADMIN_EMAIL=... SUPER_ADMIN_NAME="..." SUPER_ADMIN_PASSWORD=... npm run create-super-admin
// Super admins have no signup page on purpose.
import { Client } from "pg";
import { hashPassword, passwordProblem } from "../src/lib/auth/password.ts";

const { DATABASE_ADMIN_URL, SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME, SUPER_ADMIN_PASSWORD } = process.env;
if (!DATABASE_ADMIN_URL || !SUPER_ADMIN_EMAIL || !SUPER_ADMIN_NAME || !SUPER_ADMIN_PASSWORD) {
  console.error("Set DATABASE_ADMIN_URL, SUPER_ADMIN_EMAIL, SUPER_ADMIN_NAME and SUPER_ADMIN_PASSWORD.");
  process.exit(1);
}
const problem = passwordProblem(SUPER_ADMIN_PASSWORD);
if (problem || SUPER_ADMIN_PASSWORD.length < 14) {
  console.error(problem ?? "Use at least 14 characters for a super admin password.");
  process.exit(1);
}

const db = new Client({ connectionString: DATABASE_ADMIN_URL });
await db.connect();
try {
  await db.query("BEGIN");
  const email = SUPER_ADMIN_EMAIL.trim().toLowerCase();
  const existing = await db.query("SELECT id, role FROM users WHERE lower(email) = $1", [email]);
  if (existing.rowCount && existing.rows[0].role !== "super_admin") throw new Error("That email belongs to a clinic user.");
  const id: string = existing.rowCount
    ? existing.rows[0].id
    : (await db.query("INSERT INTO users (role, email, display_name) VALUES ('super_admin', $1, $2) RETURNING id", [email, SUPER_ADMIN_NAME])).rows[0].id;
  await db.query(
    `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [id, await hashPassword(SUPER_ADMIN_PASSWORD)],
  );
  await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
  await db.query("INSERT INTO audit_log (actor_user_id, actor_is_super, action, entity, entity_id) VALUES ($1::uuid, true, $2, 'user', $1::text)",
    [id, existing.rowCount ? "super_admin_password_set" : "super_admin_created"]);
  await db.query("COMMIT");
  console.log(`${existing.rowCount ? "Password updated for" : "Created"} super admin ${email}`);
} catch (e) {
  await db.query("ROLLBACK");
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
