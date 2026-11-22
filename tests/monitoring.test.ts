import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdir } from "node:fs/promises";
import { closePool } from "@/lib/db";
import { log, reportError, setErrorReporter } from "@/lib/monitoring";
import { checkHealth } from "@/lib/monitoring/health";

afterAll(closePool);

describe("monitoring", () => {
  it("health is ok when the database and storage are reachable", async () => {
    await mkdir(process.env.STORAGE_DIR!, { recursive: true });
    const h = await checkHealth();
    expect(h.checks).toEqual({ database: "ok", storage: "ok" });
    expect(h.ok).toBe(true);
  });

  it("health fails when storage is not writable", async () => {
    const old = process.env.STORAGE_DIR;
    process.env.STORAGE_DIR = "/nonexistent/redclinic";
    const h = await checkHealth();
    process.env.STORAGE_DIR = old;
    expect(h.ok).toBe(false);
    expect(h.checks.storage).toBe("fail");
  });

  it("logs are JSON and never contain secrets", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("info", "login", { password: "hunter22", token: "abc", sessionCookie: "x", userId: "u1" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    spy.mockRestore();
    expect(line).toMatchObject({ level: "info", msg: "login", password: "[redacted]", token: "[redacted]", sessionCookie: "[redacted]", userId: "u1" });
  });

  it("errors go to the configured reporter, and a broken reporter does not crash the app", () => {
    const seen: unknown[] = [];
    setErrorReporter({ name: "test", capture: (e) => seen.push(e) });
    reportError(new Error("boom"), { path: "/home" });
    expect(seen).toHaveLength(1);
    setErrorReporter({ name: "broken", capture: () => { throw new Error("reporter down"); } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportError(new Error("boom"))).not.toThrow();
    spy.mockRestore();
  });
});
