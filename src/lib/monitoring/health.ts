import { access, constants } from "node:fs/promises";
import { withoutUser } from "../db";

export interface Health {
  ok: boolean;
  checks: Record<string, "ok" | "fail">;
  version: string;
}

/** For uptime monitors and the container health check. Reveals no data. */
export async function checkHealth(): Promise<Health> {
  const checks: Record<string, "ok" | "fail"> = {};
  try {
    await withoutUser(async (c) => {
      await c.query("SELECT 1");
    });
    checks.database = "ok";
  } catch {
    checks.database = "fail";
  }
  if ((process.env.STORAGE_DRIVER ?? "local") === "local") {
    checks.storage = process.env.STORAGE_DIR
      ? await access(process.env.STORAGE_DIR, constants.W_OK).then(() => "ok" as const, () => "fail" as const)
      : "fail";
  }
  return {
    ok: Object.values(checks).every((v) => v === "ok"),
    checks,
    version: process.env.APP_VERSION ?? "dev",
  };
}
