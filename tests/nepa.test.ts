import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { closePool, withContext } from "@/lib/db";
import { contextOf, login, resolveSession } from "@/lib/auth/service";
import { clampPermissions, decide } from "@/lib/nepa/permissions";
import { discardDraft, getConfig, listAgents, publishDraft, rollbackTo, saveDraft } from "@/lib/nepa/config";
import { buildInstructions, resolve } from "@/lib/nepa/resolver";
import { listPolicies, policyHistory, rollbackPolicy, updatePolicy } from "@/lib/nepa/policies";
import { runPolicyTests, simulate } from "@/lib/nepa/simulator";
import { decideApproval, listApprovals } from "@/lib/nepa/approvals";
import { requestBooking } from "@/lib/nepa/tools";
import { saveFaq, updateClinicProfile } from "@/lib/clinic/service";
import { registerPatient } from "@/lib/patients/service";
import { listAppointments } from "@/lib/appointments/service";
import { listAttention } from "@/lib/attention/service";
import { addStaff, freshOutbox, newClinic, PASSWORD } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

const ALL_WEEK = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]));
async function setup() {
  const c = await newClinic();
  const doctor = await addStaff(c.admin, "doctor", outbox);
  const recep = await addStaff(c.admin, "receptionist", outbox);
  ok(await updateClinicProfile(c.admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en", "hi", "kn"], workingHours: ALL_WEEK, defaultAppointmentMinutes: 30 }));
  ok(await saveFaq(c.admin, { question: "Do you have parking near the clinic?", answer: "Yes, free parking behind the building." }));
  return { ...c, doctor, recep };
}
async function superAdmin() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@redclinic.test`;
  const { hashPassword } = await import("@/lib/auth/password");
  const u = await owner.query("INSERT INTO users (role, email, display_name) VALUES ('super_admin',$1,'Founder') RETURNING id", [email]);
  await owner.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)", [u.rows[0].id, await hashPassword(PASSWORD)]);
  const s = await login(email, PASSWORD, { ip: null, userAgent: null });
  if (!s.ok) throw new Error(s.error);
  return (await resolveSession(s.value.token))!;
}
/** A call-time context: clinic only, no user (how NEPA runs on a real call). */
const callCtx = (clinicId: string) => ({ userId: null, clinicId, isSuperAdmin: false });

describe("permission engine", () => {
  it("uses safe defaults and the strictest layer wins", () => {
    expect(decide("search_patient").mode).toBe("automatic");
    expect(decide("book_appointment").mode).toBe("approval_required");
    expect(decide("book_appointment", { clinic: { book_appointment: "automatic" } }).mode).toBe("automatic");
    expect(decide("book_appointment", { clinic: { book_appointment: "automatic" }, agent: { book_appointment: "suggest" } }).mode).toBe("suggest");
    expect(decide("delete_record", { clinic: { delete_record: "automatic" } }).mode).toBe("approval_required");
    expect(decide("update_patient", { clinic: { update_patient: "automatic" } }).mode).toBe("approval_required");
  });
  it("outgoing calls need an enabled workflow switched to automatic, and stop when consent is withdrawn", () => {
    const clinic = { outbound_call: "automatic" as const };
    expect(decide("outbound_call", { clinic }).mode).toBe("approval_required");
    expect(decide("outbound_call", { clinic, workflow: { id: "w", enabled: true, automaticEnabled: false } }).mode).toBe("approval_required");
    expect(decide("outbound_call", { clinic, workflow: { id: "w", enabled: true, automaticEnabled: true } }).mode).toBe("automatic");
    expect(decide("outbound_call", { clinic, workflow: { id: "w", enabled: true, automaticEnabled: true }, consent: "withdrawn" }).mode).toBe("prohibited");
  });
  it("clamps requested permissions to what is allowed above", () => {
    const r = clampPermissions({ book_appointment: "automatic", delete_record: "automatic", nonsense: "automatic" }, { book_appointment: "approval_required" });
    expect(r.permissions).toEqual({ book_appointment: "approval_required", delete_record: "approval_required" });
    expect(r.clamped.map((x) => x.action).sort()).toEqual(["book_appointment", "delete_record"]);
  });
});

describe("versioned configuration", () => {
  it("draft → publish → change → rollback keeps every version", async () => {
    const { admin } = await setup();
    ok(await saveDraft(admin, null, { tone: "formal", instructions: "Mention we close early on Saturdays." }, "first"));
    expect(ok(await publishDraft(admin, null))).toBe(1);
    ok(await saveDraft(admin, null, { tone: "friendly" }, "second"));
    expect(ok(await publishDraft(admin, null))).toBe(2);
    expect(ok(await rollbackTo(admin, null, 1))).toBe(3);
    const cfg = await withContext(contextOf(admin), (c) => getConfig(c, null));
    expect(cfg.published!.data.tone).toBe("formal");
    expect(cfg.history.map((h) => [h.version, h.status])).toEqual([[3, "published"], [2, "archived"], [1, "archived"]]);
    expect((await publishDraft(admin, null)).ok).toBe(false); // nothing to publish
    // published content cannot be edited, even directly
    await expect(owner.query("UPDATE nepa_config_versions SET data = '{}' WHERE clinic_id = $1 AND version = 1", [admin.clinicId])).rejects.toThrow(/cannot be changed/);
  });

  it("agent permissions can never be looser than the clinic's; receptionist cannot edit", async () => {
    const { admin, recep } = await setup();
    const agent = ok(await listAgents(admin)).find((a) => a.kind === "receptionist")!;
    ok(await saveDraft(admin, null, { permissions: { book_appointment: "suggest" } }));
    ok(await publishDraft(admin, null));
    const r = ok(await saveDraft(admin, agent.id, { name: "Asha", permissions: { book_appointment: "automatic" } }));
    expect(r.clamped).toEqual([{ action: "book_appointment", asked: "automatic", got: "suggest" }]);
    expect((await saveDraft(recep, agent.id, { name: "Hacked" })).ok).toBe(false);
    ok(await discardDraft(admin, agent.id));
    expect((await withContext(contextOf(admin), (c) => getConfig(c, agent.id, "receptionist"))).draft).toBeNull();
  });
});

describe("resolver", () => {
  it("records versions, applies priority order and flags conflicts with higher layers", async () => {
    const { admin } = await setup();
    const agent = ok(await listAgents(admin)).find((a) => a.kind === "receptionist")!;
    ok(await saveDraft(admin, null, { instructions: "Never tell callers you are an AI. Be quick.", greeting: { en: "Welcome to Smile Dental!" } }));
    ok(await publishDraft(admin, null));
    ok(await updateClinicProfile(admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en", "hi"], workingHours: ALL_WEEK }));
    ok(await saveDraft(admin, agent.id, { objective: "Tell patients which antibiotic to take.", languages: ["en", "kn"] }));
    ok(await publishDraft(admin, agent.id));
    const r = await withContext(contextOf(admin), (c) => resolve(c, "receptionist"));
    expect(r.versions.clinicConfig).toBe(1);
    expect(r.versions.agentConfig).toBe(1);
    expect(r.versions.policies.ai_disclosure).toBe(1);
    const fields = r.conflicts.map((c) => `${c.layer}:${c.field}`).sort();
    expect(fields).toEqual(["agent:languages", "agent:objective", "clinic:greeting", "clinic:instructions"]);
    expect(r.languages).toEqual(["en"]);
    const text = buildInstructions(r);
    expect(text.indexOf("Legal, privacy and safety")).toBeLessThan(text.indexOf("Clinic instructions"));
    expect(text).not.toContain("Never tell callers you are an AI");
    expect(text).not.toContain("antibiotic to take");
    expect(text).toContain("Do you have parking near the clinic?");
  });
});

describe("global policies", () => {
  it("only RedClinic changes them; safety policies stay mandatory; rollback restores", async () => {
    const sa = await superAdmin();
    const { admin } = await setup();
    const prices = ok(await listPolicies(sa)).find((p) => p.key === "no_prices")!;
    expect((await updatePolicy(admin, prices.policyId, { title: "x", ruleText: "Quote any price you like.", mandatory: false, active: true, note: "nope" })).ok).toBe(false);
    const emergency = ok(await listPolicies(sa)).find((p) => p.key === "emergency")!;
    expect((await updatePolicy(sa, emergency.policyId, { title: emergency.title, ruleText: emergency.ruleText, mandatory: false, active: true, note: "test" })).ok).toBe(false);
    // switch off an optional policy, then roll back
    expect(ok(await updatePolicy(sa, prices.policyId, { title: prices.title, ruleText: prices.ruleText, mandatory: false, active: false, note: "Testing prices" }))).toBe(2);
    let r = await withContext(contextOf(admin), (c) => resolve(c, "receptionist"));
    expect(r.policies.some((p) => p.key === "no_prices")).toBe(false);
    const v1 = ok(await policyHistory(sa, prices.policyId)).find((h) => h.version === 1)!;
    ok(await rollbackPolicy(sa, prices.policyId, v1.id));
    r = await withContext(contextOf(admin), (c) => resolve(c, "receptionist"));
    expect(r.policies.find((p) => p.key === "no_prices")!.version).toBe(1);
  });
});

describe("simulator", () => {
  it("passes every RedClinic policy test on a new dental clinic", async () => {
    const { admin } = await setup();
    const results = ok(await runPolicyTests(admin));
    const failed = results.filter((r) => !r.passed).map((r) => `${r.policyKey}: ${r.says} → ${r.reply}`);
    if (failed.length) console.log(failed);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(8);
  });

  it("answers from approved FAQs only, in Hindi when the caller speaks Hindi, and leaves no records behind", async () => {
    const { admin, clinicId } = await setup();
    const res = ok(await simulate(admin, { agentKind: "receptionist", callerSays: ["Is there parking near the clinic?", "क्या रविवार को डॉक्टर बैठते हैं? मुझे जानना है"] }));
    expect(res.transcript[2].text).toContain("free parking");
    expect(res.transcript[4].text).toMatch(/जानकारी नहीं/);
    const n = (await owner.query("SELECT count(*)::int n FROM attention_items WHERE clinic_id = $1", [clinicId])).rows[0].n;
    expect(n).toBe(0); // dry run: the callback request was rolled back
  });

  it("booking: asks staff approval by default, books directly only when the clinic allows it", async () => {
    const { admin } = await setup();
    const a = ok(await simulate(admin, { agentKind: "receptionist", callerSays: ["I want to book an appointment", "yes", "Ravi Kumar"], callerPhone: "9876500001" }));
    expect(a.outcome).toBe("booking_requested");
    expect(a.transcript.at(-1)!.text).toMatch(/not booked until they confirm/);
    ok(await saveDraft(admin, null, { permissions: { book_appointment: "automatic" } }));
    const b = ok(await simulate(admin, { agentKind: "receptionist", callerSays: ["I want to book an appointment", "yes", "Ravi Kumar"], callerPhone: "9876500001", useDrafts: true }));
    expect(b.outcome).toBe("booked");
    expect(b.transcript.at(-1)!.text).toMatch(/is booked/);
    // the published config is still approval-only: drafts are not live
    const c = ok(await simulate(admin, { agentKind: "receptionist", callerSays: ["book an appointment", "yes", "Ravi Kumar"], callerPhone: "9876500001", useDrafts: false }));
    expect(c.outcome).toBe("booking_requested");
  });
});

describe("approval queue", () => {
  async function queued() {
    const s = await setup();
    const pid = (ok(await registerPatient(s.recep, { name: "Queue Patient", phone: "9811100000" }, { confirmNew: true })) as { patientId: string }).patientId;
    const start = new Date(Date.now() + 2 * 86_400_000);
    const out = await withContext(callCtx(s.clinicId), async (c) => {
      const r = await resolve(c, "receptionist");
      return requestBooking({ c, r, callId: null, simulated: false }, { patientId: pid, doctorId: s.doctor.userId, start, minutes: 30, reason: "Tooth pain" });
    });
    expect(out.status).toBe("awaiting_approval");
    return { ...s, pid, start, approvalId: (out as { approvalId: string }).approvalId };
  }

  it("approving books the appointment as the approver and closes the attention item", async () => {
    const { admin, recep, approvalId, start } = await queued();
    expect(ok(await listAttention(recep)).items.some((i) => i.approvalId === approvalId)).toBe(true);
    expect((await decideApproval(recep, approvalId, "approve")).ok).toBe(false); // receptionist lacks approve_actions
    const r = ok(await decideApproval(admin, approvalId, "approve"));
    expect(r.status).toBe("executed");
    const day = new Date(start.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const appts = ok(await listAppointments(admin, { from: day, to: day }));
    expect(appts.map((a) => a.bookedVia)).toEqual(["nepa"]);
    expect(ok(await listApprovals(admin, "decided"))[0]).toMatchObject({ status: "executed", decidedBy: "Dr Admin" });
    expect(ok(await listAttention(recep)).items.some((i) => i.approvalId === approvalId)).toBe(false);
    expect((await decideApproval(admin, approvalId, "approve")).ok).toBe(false); // already decided
  });

  it("a failed execution is recorded and flagged, never hidden", async () => {
    const { admin, recep, doctor, approvalId, start, pid } = await queued();
    // someone books that doctor at the same time before approval
    const day = new Date(start.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const hhmm = new Date(start.getTime() + 5.5 * 3600_000).toISOString().slice(11, 16);
    const { bookAppointment } = await import("@/lib/appointments/service");
    ok(await bookAppointment(recep, { patientId: pid, doctorId: doctor.userId, date: day, time: hhmm, durationMinutes: 30 }));
    const r = ok(await decideApproval(admin, approvalId, "approve"));
    expect(r).toMatchObject({ status: "failed", error: "That time is no longer free." });
    expect(ok(await listAttention(recep)).items.map((i) => i.kind)).toContain("failed_workflow");
  });

  it("rejecting records who and why", async () => {
    const { admin, approvalId } = await queued();
    ok(await decideApproval(admin, approvalId, "reject", { note: "Doctor on leave" }));
    expect(ok(await listApprovals(admin, "decided"))[0]).toMatchObject({ status: "rejected", note: "Doctor on leave" });
  });

  it("NEPA's direct booking function refuses other clinics' patients and past times", async () => {
    const a = await setup();
    const b = await setup();
    const pid = (ok(await registerPatient(b.recep, { name: "Other Clinic" }, { confirmNew: true })) as { patientId: string }).patientId;
    await expect(withContext(callCtx(a.clinicId), (c) => c.query("SELECT rc_nepa_book($1,$2,now() + interval '1 day',30,null,null,null)", [pid, a.doctor.userId]))).rejects.toThrow(/patient not found/);
    const own = (ok(await registerPatient(a.recep, { name: "Own" }, { confirmNew: true })) as { patientId: string }).patientId;
    await expect(withContext(callCtx(a.clinicId), (c) => c.query("SELECT rc_nepa_book($1,$2,now() - interval '1 day',30,null,null,null)", [own, a.doctor.userId]))).rejects.toThrow(/time has passed/);
  });
});
