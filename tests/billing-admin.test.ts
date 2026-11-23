import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { closePool, withContext } from "@/lib/db";
import { contextOf, login, resolveSession, inviteStaff } from "@/lib/auth/service";
import { applyBillingEvent, assignPlan, billingTick, clinicBilling, entitlements, listPlans, savePlan } from "@/lib/billing/service";
import { assignNumber, auditLog, clinicDetail, listClinics, setClinicStatus, setFeature } from "@/lib/admin/service";
import { queueOutbound, startCall, endCall } from "@/lib/calls/service";
import { listAgents, setAgentEnabled } from "@/lib/nepa/config";
import { listCapabilities } from "@/lib/staff/service";
import { listAttention } from "@/lib/attention/service";
import { registerPatient } from "@/lib/patients/service";
import { ask } from "@/lib/assistant/service";
import { addStaff, freshOutbox, newClinic, PASSWORD, uniqueEmail } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

let superUser: Awaited<ReturnType<typeof makeSuper>> | null = null;
async function makeSuper() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@redclinic.test`;
  const { hashPassword } = await import("@/lib/auth/password");
  const u = await owner.query("INSERT INTO users (role, email, display_name) VALUES ('super_admin',$1,'Founder') RETURNING id", [email]);
  await owner.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)", [u.rows[0].id, await hashPassword(PASSWORD)]);
  const s = await login(email, PASSWORD, { ip: null, userAgent: null });
  if (!s.ok) throw new Error(s.error);
  return (await resolveSession(s.value.token))!;
}
const sa = async () => (superUser ??= await makeSuper());
const ent = (clinicId: string) => withContext({ userId: null, clinicId, isSuperAdmin: false }, entitlements);
const invoiceOf = async (clinicId: string) => (await owner.query("SELECT * FROM invoices WHERE clinic_id = $1 ORDER BY issued_at DESC LIMIT 1", [clinicId])).rows[0];
const pay = (number: string, type: "payment.succeeded" | "payment.failed" = "payment.succeeded", id = `${number}-${type}`) =>
  applyBillingEvent({ provider: "simulated", eventId: id, type, invoiceNumber: number, simulated: true });
async function patient(actor: Parameters<typeof registerPatient>[0], name: string, phone: string) {
  return (ok(await registerPatient(actor, { name, phone }, { confirmNew: true })) as { patientId: string }).patientId;
}

describe("plans and subscriptions", () => {
  it("a new clinic starts a Growth trial with incoming and outgoing calls", async () => {
    const { clinicId } = await newClinic();
    expect(await ent(clinicId)).toMatchObject({ planCode: "growth", status: "trialing", outboundCalls: true, serviceActive: true, voiceMinutes: 700 });
  });

  it("assigning a plan issues an invoice with GST and the setup fee (unless waived with a reason)", async () => {
    const s = await sa();
    const a = await newClinic();
    ok(await assignPlan(s, a.clinicId, { planCode: "starter", period: "monthly" }));
    const inv = await invoiceOf(a.clinicId);
    expect(inv.items.map((i: { label: string }) => i.label)).toEqual(["Starter plan (1 month)", "One-time setup and training"]);
    expect(Number(inv.subtotal_paise)).toBe(299900 + 999900);
    expect(Number(inv.gst_paise)).toBe(Math.round((299900 + 999900) * 0.18));
    expect(await ent(a.clinicId)).toMatchObject({ planCode: "starter", status: "grace", serviceActive: true, outboundCalls: false });
    const b = await newClinic();
    expect((await assignPlan(s, b.clinicId, { planCode: "growth", period: "annual", waiveSetup: true })).ok).toBe(false);
    ok(await assignPlan(s, b.clinicId, { planCode: "growth", period: "annual", waiveSetup: true, waiverNote: "3 references given and called" }));
    const binv = await invoiceOf(b.clinicId);
    expect(binv.items).toEqual([{ label: "Growth plan (12 months, pay for 11)", quantity: 1, unit_paise: 799900 * 11, amount_paise: 799900 * 11 }]);
    expect((await assignPlan(a.admin, a.clinicId, { planCode: "scale", period: "monthly" })).ok).toBe(false); // clinic admin cannot
  });

  it("payments: success activates, duplicates are ignored, failure gives a grace period, then service stops", async () => {
    const s = await sa();
    const { clinicId, admin } = await newClinic();
    ok(await assignPlan(s, clinicId, { planCode: "growth", period: "monthly" }));
    const inv = await invoiceOf(clinicId);
    expect(await pay(inv.number)).toEqual({ duplicate: false });
    expect(await pay(inv.number)).toEqual({ duplicate: true });
    expect(await ent(clinicId)).toMatchObject({ status: "active" });
    expect((await invoiceOf(clinicId)).status).toBe("paid");
    // the next renewal fails
    await owner.query("UPDATE subscriptions SET current_period_end = now() - interval '1 minute' WHERE clinic_id = $1 AND status = 'active'", [clinicId]);
    await billingTick();
    const renewal = await invoiceOf(clinicId);
    expect(renewal.number).not.toBe(inv.number);
    await pay(renewal.number, "payment.failed");
    expect(await ent(clinicId)).toMatchObject({ status: "grace", serviceActive: true });
    expect(ok(await listAttention(admin)).items.map((i) => i.kind)).toContain("billing");
    await billingTick(new Date(Date.now() + 8 * 86_400_000));
    expect(await ent(clinicId)).toMatchObject({ status: "expired", serviceActive: false });
    // NEPA pauses: incoming calls go straight to staff, outgoing calls are not made
    const call = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000100", simulated: false });
    expect(call).toMatchObject({ ended: true, handedOff: true });
    const pid = await patient(admin, "Lapsed Plan", "9000000101");
    expect((await queueOutbound(clinicId, { patientId: pid, purpose: "recall" })).mode).toBe("prohibited");
  });

  it("renewal bills extra minutes from the period that ended; cancellation ends at the period end", async () => {
    const s = await sa();
    const { clinicId } = await newClinic();
    await owner.query("UPDATE packages SET overage_per_minute_paise = 900 WHERE code = 'starter'");
    try {
      ok(await assignPlan(s, clinicId, { planCode: "starter", period: "monthly" }));
      await pay((await invoiceOf(clinicId)).number);
      await owner.query("INSERT INTO usage_events (clinic_id, kind, quantity, occurred_at) VALUES ($1, 'voice_seconds', 310 * 60, now())", [clinicId]);
      await owner.query("UPDATE subscriptions SET current_period_end = now() + interval '1 second' WHERE clinic_id = $1 AND status = 'active'", [clinicId]);
      await new Promise((r) => setTimeout(r, 1100));
      await billingTick();
      const inv = await invoiceOf(clinicId);
      expect(inv.items.find((i: { label: string }) => i.label.startsWith("Extra voice minutes"))).toMatchObject({ quantity: 10, amount_paise: 9000 });
      await pay(inv.number);
      await applyBillingEvent({ provider: "simulated", eventId: `cancel-${clinicId}`, type: "subscription.cancelled", invoiceNumber: inv.number, simulated: true });
      await owner.query("UPDATE subscriptions SET current_period_end = now() - interval '1 second' WHERE clinic_id = $1 AND status = 'active'", [clinicId]);
      await billingTick();
      expect(await ent(clinicId)).toMatchObject({ status: "cancelled", serviceActive: false });
    } finally {
      await owner.query("UPDATE packages SET overage_per_minute_paise = NULL WHERE code = 'starter'");
    }
  });

  it("the payment webhook needs a valid signature", async () => {
    const s = await sa();
    const { clinicId } = await newClinic();
    ok(await assignPlan(s, clinicId, { planCode: "growth", period: "monthly" }));
    const number = (await invoiceOf(clinicId)).number;
    const { POST } = await import("@/app/api/billing/[provider]/route");
    const send = async (sig?: string) => {
      const raw = JSON.stringify({ eventId: `wh-${number}`, type: "payment.succeeded", invoiceNumber: number });
      const res = await POST(new NextRequest("http://localhost/api/billing/simulated", { method: "POST", body: raw, headers: { "x-signature": sig ?? createHmac("sha256", "test-billing-secret").update(raw).digest("hex") } }), { params: Promise.resolve({ provider: "simulated" }) });
      return res.status;
    };
    expect(await send("forged")).toBe(401);
    expect(await ent(clinicId)).toMatchObject({ status: "grace" });
    expect(await send()).toBe(200);
    expect(await ent(clinicId)).toMatchObject({ status: "active" });
  });
});

describe("limits and alerts", () => {
  it("Starter is incoming-only; usage alerts fire once at 80% and once at 100%; staff seats are capped", async () => {
    const s = await sa();
    const { clinicId, admin } = await newClinic();
    ok(await assignPlan(s, clinicId, { planCode: "starter", period: "monthly" }));
    const pid = await patient(admin, "Starter Patient", "9000000200");
    const q = await queueOutbound(clinicId, { patientId: pid, purpose: "recall" });
    expect(q).toMatchObject({ mode: "prohibited", reason: "The clinic's plan covers incoming calls only." });
    await owner.query("INSERT INTO usage_events (clinic_id, kind, quantity) VALUES ($1, 'voice_seconds', 245 * 60)", [clinicId]);
    const c1 = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000201", simulated: false });
    await endCall(clinicId, c1.callId, "completed", { durationSeconds: 60 });  // 246 of 300 → 82%
    const c2 = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000202", simulated: false });
    await endCall(clinicId, c2.callId, "completed", { durationSeconds: 60 });  // still 80%: no second alert
    await owner.query("INSERT INTO usage_events (clinic_id, kind, quantity) VALUES ($1, 'voice_seconds', 60 * 60)", [clinicId]);
    const c3 = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000203", simulated: false });
    await endCall(clinicId, c3.callId, "completed", { durationSeconds: 60 });
    const alerts = ok(await listAttention(admin)).items.filter((i) => i.kind === "usage_alert").map((i) => i.reason);
    expect(alerts).toHaveLength(2);
    expect(alerts.some((r) => /used up/.test(r))).toBe(true);
    // 5 staff seats on Starter: admin + 4 more
    for (let i = 0; i < 4; i++) ok(await inviteStaff(admin, { displayName: `Staff ${i}`, email: uniqueEmail("seat"), role: "receptionist" }));
    const over = await inviteStaff(admin, { displayName: "One too many", email: uniqueEmail("seat"), role: "receptionist" });
    expect(!over.ok && over.error).toMatch(/includes 5 staff accounts/);
  });

  it("the clinic admin sees plan, usage and invoices; staff do not", async () => {
    const s = await sa();
    const { clinicId, admin } = await newClinic();
    const recep = await addStaff(admin, "receptionist", outbox);
    ok(await assignPlan(s, clinicId, { planCode: "growth", period: "monthly" }));
    const b = ok(await clinicBilling(admin));
    expect(b.plan?.name).toBe("Growth");
    expect(b.invoices[0].simulated).toBe(true);
    expect((await clinicBilling(recep)).ok).toBe(false);
  });
});

describe("super admin", () => {
  it("only RedClinic sees the clinics list and the admin powers", async () => {
    const s = await sa();
    const { admin, clinicId } = await newClinic();
    expect((await listClinics(admin)).ok).toBe(false);
    expect((await setClinicStatus(admin, clinicId, "suspended", "trying")).ok).toBe(false);
    expect((await savePlan(admin, ok(await listPlans(s))[0].id, {} as never)).ok).toBe(false);
    expect(ok(await listClinics(s)).some((c) => c.id === clinicId)).toBe(true);
  });

  it("kill switch: a paused clinic cannot sign in and NEPA stops; resuming restores it", async () => {
    const s = await sa();
    const { clinicId, adminEmail } = await newClinic();
    expect((await setClinicStatus(s, clinicId, "suspended", "x")).ok).toBe(false);  // needs a reason
    ok(await setClinicStatus(s, clinicId, "suspended", "Unpaid for 30 days"));
    expect((await login(adminEmail, PASSWORD, { ip: null, userAgent: null })).ok).toBe(false);
    await expect(startCall(clinicId, { direction: "inbound", callerNumber: "9000000300", simulated: false })).rejects.toThrow();
    ok(await setClinicStatus(s, clinicId, "active", ""));
    expect((await login(adminEmail, PASSWORD, { ip: null, userAgent: null })).ok).toBe(true);
  });

  it("feature switches take effect at once and clinics cannot turn them back on", async () => {
    const s = await sa();
    const { clinicId, admin } = await newClinic();
    const m = await addStaff(admin, "clinic_manager", outbox);
    await owner.query("INSERT INTO staff_capabilities (user_id, clinic_id, capability) VALUES ($1,$2,'export_data')", [m.userId, clinicId]);
    ok(await setFeature(s, clinicId, "cap:export_data", false));
    expect((await owner.query("SELECT count(*)::int n FROM staff_capabilities WHERE user_id = $1 AND capability = 'export_data'", [m.userId])).rows[0].n).toBe(0);
    expect(ok(await listCapabilities(admin)).find((x) => x.code === "export_data")!.allowed).toBe(false);
    ok(await setFeature(s, clinicId, "nepa_outbound", false));
    const pid = await patient(admin, "Feature Patient", "9000000400");
    expect((await queueOutbound(clinicId, { patientId: pid, purpose: "recall" })).mode).toBe("prohibited");
    const reminder = ok(await listAgents(admin)).find((a) => a.kind === "reminder")!;
    expect((await setAgentEnabled(admin, reminder.id, true)).ok).toBe(false);
    ok(await setFeature(s, clinicId, "assistant", false));
    expect((await ask(admin, "calls today")).ok).toBe(false);
  });

  it("assigns NEPA numbers without clashes, and every look at a clinic is audited", async () => {
    const s = await sa();
    const a = await newClinic();
    const b = await newClinic();
    const num = `+91 80 ${String(Date.now()).slice(-4)} ${String(Math.floor(Math.random() * 9000) + 1000)}`;
    ok(await assignNumber(s, a.clinicId, { receptionistNumber: num, verified: true }));
    expect((await assignNumber(s, b.clinicId, { receptionistNumber: num, verified: false })).ok).toBe(false);
    const d = ok(await clinicDetail(s, a.clinicId));
    expect(d.phone).toMatchObject({ receptionistNumber: num, status: "verified" });
    expect(d.terms?.terms_version).toBeTruthy();
    const log = ok(await auditLog(s, { clinicId: a.clinicId, superOnly: true }));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["number_assigned", "super_admin_viewed_clinic"]));
    // the clinic admin sees RedClinic's look in their own audit trail
    const seen = await withContext(contextOf(a.admin), async (c) => (await c.query("SELECT count(*)::int n FROM audit_log WHERE action = 'super_admin_viewed_clinic'")).rows[0].n);
    expect(seen).toBeGreaterThanOrEqual(1);
  });

  it("plans: prices must be set before a plan goes live", async () => {
    const s = await sa();
    const starter = ok(await listPlans(s)).find((p) => p.code === "starter")!;
    const base = { name: "Starter", description: "", priceMonthly: "", priceAnnual: "", overagePerMinute: "", setupFee: "", gstPercent: 18, trialDays: 14, voiceMinutes: 300, outboundCalls: false, staffAccounts: 5, status: "active" as const, notes: "" };
    expect((await savePlan(s, starter.id, base)).ok).toBe(false);
    ok(await savePlan(s, starter.id, { ...base, priceMonthly: "2999", priceAnnual: "32989", setupFee: "9999", status: "draft" }));
    expect(ok(await listPlans(s)).find((p) => p.code === "starter")!.priceMonthlyPaise).toBe(299900);
  });
});
