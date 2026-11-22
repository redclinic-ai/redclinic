import { Pool, types, type PoolClient } from "pg";
import { databaseUrl } from "./env";

// The application connects as a login role that is a member of rc_app (never the owner role),
// so row-level security applies to every query.

// DATE columns come back as "YYYY-MM-DD" strings: a JavaScript Date would shift them across timezones.
types.setTypeParser(1082, (v) => v);

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: databaseUrl(), max: 10, idleTimeoutMillis: 30_000 });
    pool.on("error", (err) => console.error("[db] idle client error", err));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/** Who is acting. Built only from a verified session, never from request input (DECISIONS C5). */
export interface DbContext {
  userId: string | null;
  clinicId: string | null;
  isSuperAdmin: boolean;
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>, ctx?: DbContext): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Always set the context, even when empty, so nothing leaks from a previous use of the connection.
    await client.query("SELECT rc_set_context($1, $2, $3)", [
      ctx?.userId ?? null,
      ctx?.clinicId ?? null,
      ctx?.isSuperAdmin ?? false,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run queries as a signed-in user. Row-level security limits every query to what they may see. */
export function withContext<T>(ctx: DbContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(fn, ctx);
}

/**
 * Run queries with no signed-in user. Only the auth functions (login, signup, password reset)
 * are usable this way; every clinic table returns nothing.
 */
export function withoutUser<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(fn);
}
