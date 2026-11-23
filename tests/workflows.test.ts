import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { closePool } from "@/lib/db";
import { applyMasterUpdate, createWorkflow, keepMyVersion, listWorkflows, restoreWorkflowVersion, saveWorkflow, setWorkflowSwitches, workflowHistory, workflowRuns } from "@/lib/workflows/service";
import { workflowTick } from "@/lib/workflows/engine";
import { runDialer, getCall } from "@/lib/calls/service";
import { listApprovals } from "@/lib/nepa/approvals";
import { publishDraft, saveDraft } from "@/lib/nepa/config";
import { saveService, updateClinicProfile } from "@/lib/clinic/service";
import { registerPatient } from "@/lib/patients/service";
import { listAttention } from "@/lib/attention/service";
import { addStaff, freshOutbox, newClinic } from "./helpers";

let outbox = freshOutbox();
beforeEach(() => { outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const ALL_WEEK = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]));

async function setup(type: "dental" | "dermatology" = "dental") {
  const c = await newClinic(type);
  const doctor = await addStaff(c.admin, "doctor", outbox);
  const recep = await addStaff(c.admin, "receptionist", outbox);
  ok(await updateClinicProfile(c.admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en"], workingHours: ALL_WEEK }));
  return { ...c, doctor, recep };
}
async function patient(actor: Parameters<typeof registerPatient>[0], name: string, phone: string) {
  return (ok(await registerPatient(actor, { name, phone }, { confirmNew: true })) as { patientId: string }).patientId;
}
async function appt(clinicId: string, pid: string, doctorId: string, startsInMin: number, status: string, serviceId: string | null = null) {
  const r = await owner.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, service_id, starts_at, ends_at, status, updated_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(mins => $5), now() + make_interval(mins => $5 + 30), $6, now()) RETURNING id`,
    [clinicId, pid, doctorId, serviceId, startsInMin, status]);
  return r.rows[0].id as string;
}
const wfByKey = async (actor: Parameters<typeof listWorkflows>[0], key: string) => ok(await listWorkflows(actor)).find((w) => w.templateKey === key)!;
const makeDue = (wfId: string) => owner.query("UPDATE workflow_runs SET next_due_at = now() - interval '1 minute' WHERE workflow_id = $1 AND status = 'active'", [wfId]);
const enableAgents = (clinicId: string) => owner.query("UPDATE nepa_agents SET enabled = true WHERE clinic_id = $1", [clinicId]);

describe("packs and clinic copies", () => {
  it("a dental clinic gets Core and Dental workflows (switched on, never automatic); another specialty gets Core only", async () => {
    const d = await setup("dental");
    const derm = await setup("dermatology");
    const dk = ok(await listWorkflows(d.admin)).filter((w) => w.format === 2).map((w) => w.templateKey).sort();
    expect(dk).toEqual(["appointment_confirmation", "braces_adjustment", "enquiry_followup", "no_show_recovery", "post_procedure_checkin", "rct_next_visit", "routine_recall"]);
    expect(ok(await listWorkflows(derm.admin)).map((w) => w.templateKey).sort()).toEqual(["appointment_confirmation", "enquiry_followup", "no_show_recovery", "routine_recall"]);
    expect(ok(await listWorkflows(d.admin)).filter((w) => w.format === 2).every((w) => w.enabled && !w.automatic)).toBe(true);
    const conf = await wfByKey(d.admin, "appointment_confirmation");
    expect(conf.summary).toEqual(["3 hours before the appointment: NEPA calls to confirm the appointment (only if not confirmed yet)."]);
  });

  it("editing makes a new version, keeps history, never changes the master, and can be restored", async () => {
    const { admin, recep } = await setup();
    const w = await wfByKey(admin, "appointment_confirmation");
    const def = { ...w.definition!, steps: [{ ...w.definition!.steps[0], beforeAppointmentMinutes: 120 }] };
    expect(ok(await saveWorkflow(admin, w.id, { name: "Confirm 2 hours before", definition: def, note: "Patients prefer 2 hours" }))).toBe(2);
    const master = (await owner.query("SELECT t.steps FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id WHERE p.key='core' AND t.key='appointment_confirmation'")).rows[0].steps;
    expect(master.steps[0].beforeAppointmentMinutes).toBe(180);
    expect(ok(await workflowHistory(admin, w.id)).map((h) => [h.version, h.note])).toEqual([[2, "Patients prefer 2 hours"], [1, "Before edit"]]);
    ok(await restoreWorkflowVersion(admin, w.id, 1));
    expect((await wfByKey(admin, "appointment_confirmation")).definition!.steps[0].beforeAppointmentMinutes).toBe(180);
    expect((await saveWorkflow(recep, w.id, { name: "x", definition: def })).ok).toBe(false);
  });

  it("rejects unsafe or broken definitions in plain words", async () => {
    const { admin } = await setup();
    const w = await wfByKey(admin, "no_show_recovery");
    const fourCalls = { ...w.definition!, steps: [0, 60, 120, 180].map((m, i) => ({ key: `c${i}`, afterMinutes: m, action: "call", purpose: "no_show_followup", onlyIf: "not_rebooked" })) };
    const r = await saveWorkflow(admin, w.id, { name: w.name, definition: fourCalls });
    expect(!r.ok && r.error).toBe("A workflow can call a patient at most 3 times.");
    const wrong = { trigger: { event: "appointment_no_show" }, steps: [{ key: "a", beforeAppointmentMinutes: 60, action: "call", purpose: "confirmation" }] };
    expect((await saveWorkflow(admin, w.id, { name: w.name, definition: wrong })).ok).toBe(false);
  });

  it("only the clinic admin can make a workflow automatic; switching off also turns automatic off", async () => {
    const { admin, clinicId } = await setup();
    const m = await addStaff(admin, "clinic_manager", outbox);
    await owner.query("INSERT INTO staff_capabilities (user_id, clinic_id, capability) VALUES ($1,$2,'edit_workflow')", [m.userId, clinicId]);
    const w = await wfByKey(admin, "routine_recall");
    expect((await setWorkflowSwitches(m, w.id, { enabled: true, automatic: true })).ok).toBe(false);
    ok(await setWorkflowSwitches(m, w.id, { enabled: true }));
    ok(await setWorkflowSwitches(admin, w.id, { automatic: true }));
    expect(await wfByKey(admin, "routine_recall")).toMatchObject({ enabled: true, automatic: true });
    ok(await setWorkflowSwitches(admin, w.id, { enabled: false }));
    expect(await wfByKey(admin, "routine_recall")).toMatchObject({ enabled: false, automatic: false });
  });

  it("a RedClinic update is offered, never applied silently; clinics can keep their version", async () => {
    const a = await setup();
    const wfA = await wfByKey(a.admin, "routine_recall");
    ok(await saveWorkflow(a.admin, wfA.id, { name: "Our recall", definition: { trigger: { event: "months_since_last_visit", months: 4 }, steps: [{ key: "r", afterMinutes: 0, action: "call", purpose: "recall", onlyIf: "no_upcoming" }] } }));
    // RedClinic publishes Core v2 with a changed recall
    await owner.query(`WITH p AS (INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format) VALUES ('core','all','Core workflows',2,true,'draft',2) RETURNING id)
      INSERT INTO workflow_templates (pack_id, key, name, steps) SELECT p.id, t.key, t.name, CASE WHEN t.key='routine_recall' THEN jsonb_set(t.steps, '{trigger,months}', '5') ELSE t.steps END
      FROM p, workflow_templates t JOIN workflow_packs o ON o.id = t.pack_id WHERE o.key='core' AND o.version=1`);
    await owner.query("UPDATE workflow_packs SET is_active = false WHERE key='core' AND version=1");
    try {
      let w = await wfByKey(a.admin, "routine_recall");
      expect(w.definition!.trigger.months).toBe(4);             // still the clinic's own version
      expect(w.updateAvailable?.packVersion).toBe(2);
      ok(await keepMyVersion(a.admin, w.id));
      expect((await wfByKey(a.admin, "routine_recall")).updateAvailable).toBeNull();
      const conf = await wfByKey(a.admin, "appointment_confirmation");
      expect(conf.updateAvailable?.packVersion).toBe(2);
      ok(await applyMasterUpdate(a.admin, conf.id));
      w = await wfByKey(a.admin, "appointment_confirmation");
      expect(w.updateAvailable).toBeNull();
      expect(ok(await workflowHistory(a.admin, conf.id))[0].note).toMatch(/RedClinic update/);
    } finally {
      await owner.query("UPDATE clinic_workflows SET source_template_id = NULL WHERE source_template_id IN (SELECT t.id FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id WHERE p.key='core' AND p.version=2)");
      await owner.query("DELETE FROM workflow_templates WHERE pack_id IN (SELECT id FROM workflow_packs WHERE key='core' AND version=2)");
      await owner.query("DELETE FROM workflow_packs WHERE key='core' AND version=2");
      await owner.query("UPDATE workflow_packs SET is_active = true WHERE key='core' AND version=1");
    }
  });

  it("clinics can add their own workflow; it starts switched off", async () => {
    const { admin } = await setup();
    const id = ok(await createWorkflow(admin, { name: "Whitening follow-up", definition: { trigger: { event: "appointment_completed", serviceMatch: ["whitening"] }, steps: [{ key: "a", afterMinutes: 10080, action: "call", purpose: "checkin", onlyIf: "always" }] } }));
    expect(ok(await listWorkflows(admin)).find((w) => w.id === id)).toMatchObject({ enabled: false, automatic: false, packKey: null });
  });
});

describe("workflow engine", () => {
  it("confirmation: asks approval by default; goes straight to the call queue when automatic; skips confirmed appointments", async () => {
    const { admin, recep, doctor, clinicId } = await setup();
    await enableAgents(clinicId);
    const w = await wfByKey(admin, "appointment_confirmation");
    ok(await setWorkflowSwitches(admin, w.id, { enabled: true }));
    const p1 = await patient(recep, "Two Hours", "9811100001");
    const p2 = await patient(recep, "Already Confirmed", "9811100002");
    await appt(clinicId, p1, doctor.userId, 120, "scheduled");
    await appt(clinicId, p2, doctor.userId, 150, "confirmed");
    const t = await workflowTick(clinicId);
    expect(t.created).toBe(2);
    expect(t.processed.map((x) => x.result).sort()).toEqual(["call waiting for approval", "skipped: Already confirmed."]);
    expect(ok(await listApprovals(admin)).map((a) => a.action)).toEqual(["send_reminder"]);
    // running again does nothing new
    expect((await workflowTick(clinicId)).processed).toEqual([]);
    // now the clinic lets confirmations run automatically
    ok(await setWorkflowSwitches(admin, w.id, { automatic: true }));
    ok(await saveDraft(admin, null, { permissions: { send_reminder: "automatic" } })); ok(await publishDraft(admin, null));
    const p3 = await patient(recep, "Auto Confirm", "9811100003");
    await appt(clinicId, p3, doctor.userId, 60, "scheduled");
    expect((await workflowTick(clinicId)).processed.map((x) => x.result)).toEqual(["call queued"]);
    const [callId] = await runDialer(clinicId, { ignoreQuietHours: true, simulateConversation: ["yes"] });
    expect(ok(await getCall(admin, callId)).outcome).toBe("confirmed");
  });

  it("no-show: two calls then staff, and it stops as soon as the patient rebooks", async () => {
    const { admin, recep, doctor, clinicId } = await setup();
    await enableAgents(clinicId);
    const w = await wfByKey(admin, "no_show_recovery");
    ok(await setWorkflowSwitches(admin, w.id, { enabled: true }));
    const p = await patient(recep, "No Show", "9822200001");
    await appt(clinicId, p, doctor.userId, -60, "no_show");
    expect((await workflowTick(clinicId)).processed.map((x) => x.result)).toEqual(["call waiting for approval"]);
    const run = ok(await workflowRuns(admin, w.id))[0];
    expect(run.nextStep).toBe(1);
    expect(new Date(run.nextDueAt).getTime() - Date.now()).toBeGreaterThan(5 * 3600_000);  // second call 5.5 h after
    await appt(clinicId, p, doctor.userId, 2 * 1440, "scheduled");                         // patient rebooks
    await makeDue(w.id);
    expect((await workflowTick(clinicId)).processed.map((x) => x.result)).toEqual(["skipped: Patient rebooked."]);
    expect(ok(await workflowRuns(admin, w.id))[0]).toMatchObject({ status: "done", stopReason: "Patient rebooked." });
  });

  it("after-treatment check-in: a root canal patient reporting swelling reaches staff urgently", async () => {
    const { admin, recep, doctor, clinicId } = await setup();
    await enableAgents(clinicId);
    const svc = ok(await saveService(admin, { name: "Root canal treatment", durationMinutes: 60 }));
    const w = await wfByKey(admin, "post_procedure_checkin");
    ok(await setWorkflowSwitches(admin, w.id, { enabled: true, automatic: true }));
    ok(await saveDraft(admin, null, { permissions: { outbound_call: "automatic" } })); ok(await publishDraft(admin, null));
    const p = await patient(recep, "Checkin Patient", "9833300001");
    const other = await patient(recep, "Cleaning Patient", "9833300002");
    await appt(clinicId, p, doctor.userId, -120, "completed", svc);
    await appt(clinicId, other, doctor.userId, -180, "completed", null);       // not a procedure: no check-in
    // two runs for the root canal patient: this check-in, and the Dental Pack's "book the next visit" (on by default)
    expect((await workflowTick(clinicId)).created).toBe(2);
    expect(ok(await workflowRuns(admin, w.id)).map((r) => r.patient)).toEqual(["Checkin Patient"]);
    await makeDue(w.id);
    expect((await workflowTick(clinicId)).processed.map((x) => x.result)).toEqual(["call queued"]);
    const [callId] = await runDialer(clinicId, { ignoreQuietHours: true, simulateConversation: ["There is still swelling and some pain"] });
    const call = ok(await getCall(admin, callId));
    expect(call.transcript![0].original).toMatch(/how you are feeling after your treatment/);
    expect(call.status).toBe("handed_to_staff");
    const item = ok(await listAttention(recep, { includeSimulated: true })).items.find((i) => i.callId === callId)!;
    expect(item.urgency).toBe(1);
  });

  it("switching a workflow off stops its runs; other clinics are never touched", async () => {
    const a = await setup();
    const b = await setup();
    await enableAgents(a.clinicId);
    const w = await wfByKey(a.admin, "no_show_recovery");
    ok(await setWorkflowSwitches(a.admin, w.id, { enabled: true }));
    const p = await patient(a.recep, "Stop Me", "9844400001");
    await appt(a.clinicId, p, a.doctor.userId, -60, "no_show");
    await workflowTick(a.clinicId);
    expect((await workflowTick(b.clinicId)).created).toBe(0);
    ok(await setWorkflowSwitches(a.admin, w.id, { enabled: false }));
    await makeDue(w.id);
    await workflowTick(a.clinicId);
    expect(ok(await workflowRuns(a.admin, w.id))[0]).toMatchObject({ status: "stopped", stopReason: "Workflow switched off." });
  });
});
