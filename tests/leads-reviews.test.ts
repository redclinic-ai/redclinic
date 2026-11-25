// V2: Meta lead ads into patients + follow-up, manual enquiries, and Google review requests.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHmac } from "node:crypto";
import { userInfo } from "node:os";
import { NextRequest } from "next/server";
import { closePool } from "@/lib/db";
import { listWorkflows, setWorkflowSwitches } from "@/lib/workflows/service";
import { workflowTick } from "@/lib/workflows/engine";
import { publishDraft, saveDraft } from "@/lib/nepa/config";
import { updateClinicProfile } from "@/lib/clinic/service";
import { registerPatient } from "@/lib/patients/service";
import { getResults } from "@/lib/results/service";
import { SimulatedLeadAds, setLeadAds } from "@/lib/leads/provider";
import { addLeadForm, addManualLead, listLeads, setLeadStatus } from "@/lib/leads/service";
import { SimulatedWhatsApp, setWhatsApp } from "@/lib/whatsapp/provider";
import { queueWhatsApp, runWhatsApp, saveWhatsAppSettings, setPatientWhatsApp } from "@/lib/whatsapp/service";
import { addStaff, freshOutbox, newClinic } from "./helpers";

const SECRET = "meta-test-secret";
let wa = new SimulatedWhatsApp("x");
let outbox = freshOutbox();
beforeEach(() => { wa = new SimulatedWhatsApp("x"); setWhatsApp(wa); setLeadAds(new SimulatedLeadAds(SECRET)); outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { setWhatsApp(undefined); setLeadAds(undefined); await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const ALL_WEEK = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]));
let seq = 0;
const uniq = () => `${Date.now()}${String(seq++).padStart(3, "0")}`;

async function setup() {
  const c = await newClinic();
  const doctor = await addStaff(c.admin, "doctor", outbox);
  ok(await updateClinicProfile(c.admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en"], workingHours: ALL_WEEK }));
  const formId = uniq();
  ok(await addLeadForm(c.admin, { label: "Braces offer", pageId: "123456", formId }));
  return { ...c, doctor, formId };
}
const body = (formId: string, leadId: string, fields: Record<string, string>) => JSON.stringify({ object: "page", entry: [{ id: "123456", changes: [{ field: "leadgen", value: {
  leadgen_id: leadId, form_id: formId, page_id: "123456", created_time: Math.floor(Date.now() / 1000),
  field_data: Object.entries(fields).map(([name, v]) => ({ name, values: [v] })), campaign: { campaign_name: "Braces Nov" } } }] }] });
async function post(raw: string, secret = SECRET) {
  const { POST } = await import("@/app/api/leads/[provider]/route");
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const res = await POST(new NextRequest("http://x/api/leads/simulated", { method: "POST", body: raw, headers: { "x-hub-signature-256": sig } }), { params: Promise.resolve({ provider: "simulated" }) });
  return { status: res.status, json: await res.json() };
}
async function enable(admin: Parameters<typeof listWorkflows>[0], key: string, perms: Record<string, string>) {
  const w = ok(await listWorkflows(admin)).find((x) => x.templateKey === key)!;
  ok(await setWorkflowSwitches(admin, w.id, { enabled: true, automatic: true }));
  ok(await saveDraft(admin, null, { permissions: perms })); ok(await publishDraft(admin, null));
  return w.id;
}

describe("lead forms", () => {
  it("validates ids, and a form belongs to one clinic", async () => {
    const a = await setup();
    expect((await addLeadForm(a.admin, { label: "x", pageId: "1", formId: "abc" })).ok).toBe(false);
    const b = await newClinic();
    expect((await addLeadForm(b.admin, { label: "Same form", pageId: "123456", formId: a.formId })).ok).toBe(false);
  });
});

describe("receiving leads", () => {
  it("a lead becomes a patient with a permanent ID; repeats are ignored; a known phone matches the existing patient", async () => {
    const s = await setup();
    const existing = (ok(await registerPatient(s.admin, { name: "Known Person", phone: "9822200002" }, { confirmNew: true })) as { patientId: string }).patientId;
    const id1 = `L${uniq()}`;
    let r = await post(body(s.formId, id1, { full_name: "Neha Gupta", phone_number: "+919822200001", treatment: "braces", city: "Pune" }));
    expect(r.json.results).toEqual([{ leadId: id1, result: "new patient" }]);
    r = await post(body(s.formId, id1, { full_name: "Neha Gupta", phone_number: "+919822200001" }));
    expect(r.json.results[0].result).toBe("duplicate");
    r = await post(body(s.formId, `L${uniq()}`, { full_name: "Known P.", phone_number: "98222 00002" }));
    expect(r.json.results[0].result).toBe("matched existing patient");

    const leads = ok(await listLeads(s.admin)).leads;
    expect(leads).toHaveLength(2);
    const neha = leads.find((l) => l.name === "Neha Gupta")!;
    expect(neha).toMatchObject({ stage: "new", source: "meta_lead_ad", formLabel: "Braces offer", answers: { treatment: "braces", city: "Pune" }, campaign: { campaign_name: "Braces Nov" } });
    expect(neha.patientCode).toMatch(/\w+/);
    expect(leads.find((l) => l.name === "Known P.")!.patientId).toBe(existing);
    expect((await owner.query("SELECT first_problem FROM patients WHERE id = $1", [neha.patientId])).rows[0].first_problem).toBe("braces");
  });

  it("refuses a bad signature and ignores forms nobody linked", async () => {
    const s = await setup();
    expect((await post(body(s.formId, `L${uniq()}`, { full_name: "X Y", phone_number: "9822200003" }), "wrong")).status).toBe(401);
    expect((await post(body("999999999", `L${uniq()}`, { full_name: "X Y", phone_number: "9822200003" }))).json.results[0].result).toBe("form not linked to a clinic");
  });

  it("the follow-up workflow welcomes on WhatsApp (with opt-in) and has NEPA call within minutes", async () => {
    const s = await setup();
    ok(await saveWhatsAppSettings(s.admin, { status: "simulated", businessNumber: `9170${uniq().slice(-8)}`, phoneNumberId: "", mapsUrl: "", reviewUrl: "" }));
    await enable(s.admin, "lead_followup", { send_whatsapp: "automatic", outbound_call: "automatic" });
    await post(body(s.formId, `L${uniq()}`, { full_name: "Arjun Nair", phone_number: "9822200004", whatsapp_opt_in: "yes" }));
    let t = await workflowTick(s.clinicId);
    expect(t.processed.map((x) => x.result)).toEqual(["message queued"]);
    await runWhatsApp(s.clinicId, { ignoreQuietHours: true });
    expect(wa.sent[0].text).toMatch(/Arjun, thank you for your interest in Smile Dental/);
    await owner.query("UPDATE workflow_runs SET next_due_at = now() WHERE clinic_id = $1 AND status = 'active'", [s.clinicId]);
    t = await workflowTick(s.clinicId);
    expect(t.processed.map((x) => x.result)).toEqual(["call queued"]);
    expect(ok(await listLeads(s.admin)).leads[0].stage).toBe("new");    // queued, not yet called
  });

  it("staff can add an enquiry by hand; marking it not interested stops the follow-up; booking shows as booked", async () => {
    const s = await setup();
    await enable(s.admin, "lead_followup", { outbound_call: "automatic", send_whatsapp: "automatic" });
    const m = ok(await addManualLead(s.admin, { name: "Walk In", phone: "9822200005", problem: "tooth pain" }));
    expect(m.newPatient).toBe(true);
    const m2 = ok(await addManualLead(s.admin, { name: "Referral", phone: "9822200006" }));
    expect((await addManualLead(s.admin, { name: "No phone", phone: "123" })).ok).toBe(false);
    await workflowTick(s.clinicId);
    ok(await setLeadStatus(s.admin, m.leadId, "not_interested"));
    expect((await owner.query("SELECT status FROM workflow_runs WHERE subject_key = $1", [`lead:${m.leadId}`])).rows[0].status).toBe("stopped");
    await owner.query(`INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status) VALUES ($1,$2,$3, now() + interval '2 days', now() + interval '2 days 30 min', 'scheduled')`,
      [s.clinicId, m2.patientId, s.doctor.userId]);
    const l = ok(await listLeads(s.admin));
    expect(l.leads.find((x) => x.id === m.leadId)!.stage).toBe("not_interested");
    expect(l.leads.find((x) => x.id === m2.leadId)!.stage).toBe("booked");
    expect(l.counts.booked).toBe(1);
    const res = ok(await getResults(s.admin, "today", true));
    expect(res.values).toMatchObject({ leads_received: 2, leads_booked: 1 });
  });
});

describe("review requests", () => {
  it("need a review link; send a tracked link; at most once in 6 months; opening the link is counted", async () => {
    const s = await setup();
    const number = `9171${uniq().slice(-8)}`;
    ok(await saveWhatsAppSettings(s.admin, { status: "simulated", businessNumber: number, phoneNumberId: "", mapsUrl: "", reviewUrl: "" }));
    const p = (ok(await registerPatient(s.admin, { name: "Happy Patient", phone: "9822200007" }, { confirmNew: true })) as { patientId: string }).patientId;
    ok(await setPatientWhatsApp(s.admin, p, { status: "opted_in" }));
    expect((await queueWhatsApp(s.clinicId, { patientId: p, template: "review_request" })).reason).toMatch(/review link/);
    ok(await saveWhatsAppSettings(s.admin, { status: "simulated", businessNumber: number, phoneNumberId: "", mapsUrl: "", reviewUrl: "https://g.page/r/smile/review" }));
    await enable(s.admin, "review_request", { send_whatsapp: "automatic" });
    await owner.query(`INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status, updated_at) VALUES ($1,$2,$3, now() - interval '4 hours', now() - interval '3 hours 30 min', 'completed', now() - interval '3 hours 10 min')`,
      [s.clinicId, p, s.doctor.userId]);
    const t = await workflowTick(s.clinicId);
    expect(t.processed.map((x) => x.result)).toEqual(["message queued"]);
    await runWhatsApp(s.clinicId, { ignoreQuietHours: true });
    const link = wa.sent[0].text.match(/https?:\/\/\S+\/r\/([A-Za-z0-9_-]+)/)!;
    expect(link).toBeTruthy();
    expect(wa.sent[0].text).not.toContain("g.page");      // the patient gets the tracked link, which forwards to Google
    expect((await queueWhatsApp(s.clinicId, { patientId: p, template: "review_request" })).reason).toMatch(/last 6 months/);

    const { GET } = await import("@/app/r/[token]/route");
    const res = await GET(new NextRequest(`http://x/r/${link[1]}`), { params: Promise.resolve({ token: link[1] }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://g.page/r/smile/review");
    expect((await GET(new NextRequest("http://x/r/nope"), { params: Promise.resolve({ token: "nope" }) })).status).toBe(404);
    const v = ok(await getResults(s.admin, "today", true)).values;
    expect(v).toMatchObject({ review_requests_sent: 1, review_links_opened: 1, whatsapp_sent: 1 });
  });
});
