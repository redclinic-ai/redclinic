// Builds a fresh test database with all migrations, plus a login role that is a member of rc_app
// (the same shape as production: the app never connects as the owner).
import { execFileSync } from "node:child_process";
import path from "node:path";

const DB = "rc_vitest";
const ADMIN = process.env.TEST_DATABASE_ADMIN_URL ?? "postgresql:///postgres";

function psql(url: string, sql: string) {
  execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-qX", "-c", sql], { stdio: ["ignore", "ignore", "inherit"] });
}

export default function setup() {
  psql(ADMIN, `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  psql(ADMIN, `CREATE DATABASE ${DB}`);
  const dbUrl = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
  execFileSync("bash", [path.resolve(__dirname, "../scripts/migrate.sh")], {
    env: { ...process.env, DATABASE_ADMIN_URL: dbUrl },
    stdio: ["ignore", "ignore", "inherit"],
  });
  psql(dbUrl, `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rc_app_test') THEN
      CREATE ROLE rc_app_test LOGIN PASSWORD 'rc_app_test' IN ROLE rc_app;
    END IF; END $$;
    GRANT CONNECT ON DATABASE ${DB} TO rc_app_test;`);
}
