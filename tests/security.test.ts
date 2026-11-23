import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closePool } from "@/lib/db";
import { requestPasswordReset, signupClinic } from "@/lib/auth/service";
import { SimulatedEmailAdapter } from "@/lib/email";
import { freshOutbox, newClinic, PASSWORD, uniqueEmail } from "./helpers";

vi.mock("server-only", () => ({}));
let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
afterAll(closePool);

describe("safe redirects", () => {
  it("only allows paths on this site", async () => {
    const { safePath } = await import("@/lib/action-helpers");
    expect(safePath("/inbox?view=resolved&mine=1")).toBe("/inbox?view=resolved&mine=1");
    expect(safePath("/workflows/123#runs")).toBe("/workflows/123#runs");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "evil", ""]) expect(safePath(bad)).toBe("/home");
  });
});

describe("rate limits", () => {
  it("limits sign-ups per network", async () => {
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const make = () => signupClinic({ clinicName: "Limit Clinic", clinicType: "dental", phone: "9800000000", adminName: "Ad Min", adminEmail: uniqueEmail(), password: PASSWORD, acceptTerms: true }, ip);
    for (let i = 0; i < 5; i++) expect((await make()).ok).toBe(true);
    const sixth = await make();
    expect(!sixth.ok && sixth.error).toMatch(/Too many sign-ups/);
  });

  it("sends at most 3 reset emails per address per hour, silently", async () => {
    const { adminEmail } = await newClinic();
    for (let i = 0; i < 5; i++) await requestPasswordReset(adminEmail, "10.1.1.1");
    expect(outbox.outbox).toHaveLength(3);
  });
});

describe("email in production", () => {
  it("never writes sign-in links to the log when no provider is configured", async () => {
    const env = process.env.APP_ENV;
    process.env.APP_ENV = "production";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await new SimulatedEmailAdapter().send({ to: "doctor@clinic.test", subject: "Reset", text: "https://app/set-password?token=SECRET" });
      const logged = [...warn.mock.calls, ...info.mock.calls].flat().join(" ");
      expect(logged).not.toContain("SECRET");
      expect(logged).toContain("d***@clinic.test");
    } finally { process.env.APP_ENV = env; warn.mockRestore(); info.mockRestore(); }
  });
});
