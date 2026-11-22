// Server-side configuration. Read lazily so tests can set values before first use.
export type AppEnv = "development" | "staging" | "production" | "test";

export function appEnv(): AppEnv {
  const v = process.env.APP_ENV ?? "development";
  if (!["development", "staging", "production", "test"].includes(v)) throw new Error(`Invalid APP_ENV: ${v}`);
  return v as AppEnv;
}

export function databaseUrl(): string {
  const v = process.env.DATABASE_URL;
  if (!v) throw new Error("DATABASE_URL is not set");
  return v;
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export const isProduction = () => appEnv() === "production";
