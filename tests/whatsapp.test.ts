// V2: WhatsApp channel — settings, opt-in, workflow messages, approvals, replies, receipts, staff replies.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHmac } from "node:crypto";
import { userInfo } from "node:os";
import { NextRequest } from "next/server";
import { closePool } from "@/lib/db";
import { listWorkflows, setWorkflowSwitches } from "@/lib/workflows/service";
import { workflowTick } from "@/lib/workflows/engine";
import { decideApproval, listApprovals } from "@/lib/nepa/approvals";
import { updateClinicProfile } from "@/lib/clinic/service";
import { publishDraft, saveDraft } from "@/lib/nepa/config";
import { registerPatient } from "@/lib/patients/service";
import { listAttention } from "@/lib/attention/service";
import { SimulatedWhatsApp, setWhatsApp } from "@/lib/whatsapp/provider";
import { conversation, intentOf, listConversations, queueWhatsApp, receiveWhatsApp, runWhatsApp, saveWhatsAppSettings, setPatientWhatsApp, staffReply } from "@/lib/whatsapp/service";
import { render } from "@/lib/whatsapp/templates";
import { addStaff, freshOutbox, newClinic } from "./helpers";

const SECRET = "wa-test-secret";
let wa = new SimulatedWhatsApp(SECRET);
let outbox = freshOutbox();
beforeEach(() => { wa = new SimulatedWhatsApp(SECRET); setWhatsApp(wa); outbox = freshOutbox(); });
const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { setWhatsApp(undefined); await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };
const ALL_WEEK = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]));
let numberSeq = 0;
const nextBusinessNumber = () => `9180${String(Date.now()).slice(-6)}${String(numberSeq++).padStart(2, "0")}`;

async function setup(opts: { maps?: boolean } = {}) {
  const c = await newClinic();
  const doctor = await addStaff(c.admin, "doctor", outbox);
  ok(await updateClinicProfile(c.admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en"], workingHours: ALL_WEEK }));
  const business = nextBusinessNumber();
  ok(await saveWhatsAppSettings(c.admin, { status: "simulated", businessNumber: business, phoneNumberId: "", mapsUrl: opts.maps === false ? "" : "https://maps.app.goo.gl/smile", reviewUrl: "" }));
  return { ...c, doctor, business };
}
async function patient(actor: Parameters<typeof registerPatient>[0], name: string, phone: string, optIn = true) {
  const id = (ok(await registerPatient(actor, { name, phone }, { confirmNew: true })) as { patientId: string }).patientId;
  if (optIn) ok(await setPatientWhatsApp(actor, id, { status: "opted_in", language: "en" }));
  return id;
}
async function appt(clinicId: string, pid: string, doctorId: string, startsInMin: number, status: string) {
  return (await owner.query(
    `INSERT INTO appointments (clinic_id, patient_id, doctor_id, starts_at, ends_at, status, updated_at)
     VALUES ($1,$2,$3, now() + make_interval(mins => $4), now() + make_interval(mins => $4 + 30), $5, now()) RETURNING id`,
    [clinicId, pid, doctorId, startsInMin, status])).rows[0].id as string;
}
async function workflow(admin: Parameters<typeof listWorkflows>[0], key: string, automatic = true) {
  const w = ok(await listWorkflows(admin)).find((x) => x.templateKey === key)!;
  ok(await setWorkflowSwitches(admin, w.id, { enabled: true, automatic }));
  if (automatic) { ok(await saveDraft(admin, null, { permissions: { send_whatsapp: "automatic" } })); ok(await publishDraft(admin, null)); }
  return w.id;
}
const inbound = (to: string, from: string, text: string, id = `wamid.${Math.random().toString(36).slice(2)}`) =>
  ({ type: "message" as const, providerMessageId: id, from, to, text, at: new Date().toISOString() });

describe("templates and intents", () => {
  it("fills placeholders and refuses a template whose link is missing", () => {
    expect(render("appointment_confirmation", "en", { name: "Asha", clinic: "Smile", assistant: "Priya", when: "Monday" })).toEqual({ ok: true, text: expect.stringContaining("Reply 1 to confirm") });
    expect(render("no_show_location", "hi", { name: "Asha", clinic: "Smile", maps: null })).toEqual({ ok: false, missing: "maps" });
  });
  it("reads simple replies in English, Hindi and Kannada", () => {
    expect(intentOf("1")).toBe("confirm"); expect(intentOf("Haan")).toBe("confirm"); expect(intentOf("ಹೌದು")).toBe("confirm");
    expect(intentOf("2")).toBe("change"); expect(intentOf("STOP")).toBe("stop");
    expect(intentOf("there is a lot of bleeding")).toBe("urgent"); expect(intentOf("बहुत दर्द हो रहा है")).toBe("urgent");
    expect(intentOf("slight pain")).toBe("worry"); expect(intentOf("what time do you open?")).toBe("other");
  });
});

describe("settings", () => {
  it("validates the number and links, and one number belongs to one clinic", async () => {
    const a = await newClinic();
    expect((await saveWhatsAppSettings(a.admin, { status: "simulated", businessNumber: "", phoneNumberId: "", mapsUrl: "", reviewUrl: "" })).ok).toBe(false);
    expect((await saveWhatsAppSettings(a.admin, { status: "simulated", businessNumber: "919800000001", phoneNumberId: "", mapsUrl: "http://maps", reviewUrl: "" })).ok).toBe(false);
    expect((await saveWhatsAppSettings(a.admin, { status: "connected", businessNumber: "919800000001", phoneNumberId: "1", mapsUrl: "", reviewUrl: "" })).ok).toBe(false); // no real account
    const n = nextBusinessNumber();
    ok(await saveWhatsAppSettings(a.admin, { status: "simulated", businessNumber: n, phoneNumberId: "", mapsUrl: "", reviewUrl: "" }));
    const b = await newClinic();
    expect((await saveWhatsAppSettings(b.admin, { status: "simulated", businessNumber: n, phoneNumberId: "", mapsUrl: "", reviewUrl: "" })).ok).toBe(false);
  });
});

describe("sending", () => {
  it("never messages a patient without opt-in, or after they opted out", async () => {
    const s = await setup();
    const p = await patient(s.admin, "Ravi Shah", "9811100001", false);
    expect(await queueWhatsApp(s.clinicId, { patientId: p, template: "next_visit" })).toMatchObject({ messageId: null, mode: "prohibited", reason: expect.stringMatching(/not agreed/) });
    ok(await setPatientWhatsApp(s.admin, p, { status: "opted_out" }));
    expect((await queueWhatsApp(s.clinicId, { patientId: p, template: "next_visit" })).reason).toMatch(/asked not to/);
    expect(wa.sent).toHaveLength(0);
  });

  it("without an automatic workflow each message needs approval; approved messages are sent, rejected ones are not", async () => {
    const s = await setup();
    const p = await patient(s.admin, "Meena Rao", "9811100002");
    const q = await queueWhatsApp(s.clinicId, { patientId: p, template: "next_visit" });
    expect(q.mode).toBe("approval_required");
    expect(await runWhatsApp(s.clinicId, { ignoreQuietHours: true })).toHaveLength(0);
    const ap = ok(await listApprovals(s.admin)).find((x) => x.action === "send_whatsapp")!;
    ok(await decideApproval(s.admin, ap.id, "approve", {}));
    expect(await runWhatsApp(s.clinicId, { ignoreQuietHours: true })).toEqual([{ id: q.messageId, status: "sent" }]);
    expect(wa.sent[0]).toMatchObject({ to: "919811100002", template: { name: "next_visit", language: "en" } });
    expect(wa.sent[0].text).toContain("Smile Dental");
  });

  it("the confirmation workflow messages a day ahead; reply 1 confirms the appointment, 2 asks staff to change it", async () => {
    const s = await setup();
    await workflow(s.admin, "wa_confirmation");
    const p1 = await patient(s.admin, "Asha Kumar", "9811100003");
    const p2 = await patient(s.admin, "Kiran Das", "9811100004");
    const a1 = await appt(s.clinicId, p1, s.doctor.userId, 23 * 60, "scheduled");
    const a2 = await appt(s.clinicId, p2, s.doctor.userId, 23 * 60 + 30, "scheduled");
    await workflowTick(s.clinicId);
    const sent = await runWhatsApp(s.clinicId, { ignoreQuietHours: true });
    expect(sent.filter((x) => x.status === "sent")).toHaveLength(2);
    expect(wa.sent.map((m) => m.text).join(" ")).toMatch(/Reply 1 to confirm/);

    const r = await receiveWhatsApp([inbound(s.business, "+91 98111 00003", "1"), inbound(s.business, "919811100004", "2")], { simulated: true });
    expect(r.map((x) => x.result)).toEqual(["appointment confirmed", "change request: told staff"]);
    const st = (await owner.query("SELECT id, status, confirmed_at FROM appointments WHERE id = ANY($1)", [[a1, a2]])).rows;
    expect(st.find((x) => x.id === a1)).toMatchObject({ status: "confirmed", confirmed_at: expect.any(Date) });
    expect(st.find((x) => x.id === a2)?.status).toBe("scheduled");
    const att = ok(await listAttention(s.admin, { view: "active", includeSimulated: true }));
    expect(att.items.find((i) => i.kind === "reschedule_request" && i.appointmentId === a2)).toBeTruthy();
    // running the engine again sends nothing new
    await workflowTick(s.clinicId);
    expect((await runWhatsApp(s.clinicId, { ignoreQuietHours: true })).length).toBe(0);
  });

  it("a confirmed patient who did not come gets directions; an unconfirmed one does not (the call workflow handles them)", async () => {
    const s = await setup();
    await workflow(s.admin, "wa_no_show_confirmed");
    const pc = await patient(s.admin, "Confirmed Patient", "9811100005");
    const pu = await patient(s.admin, "Unconfirmed Patient", "9811100006");
    const ac = await appt(s.clinicId, pc, s.doctor.userId, -120, "confirmed");
    await appt(s.clinicId, pu, s.doctor.userId, -45, "scheduled");
    await owner.query("UPDATE appointments SET status='no_show', updated_at=now() WHERE clinic_id = $1", [s.clinicId]);
    await workflowTick(s.clinicId);
    await runWhatsApp(s.clinicId, { ignoreQuietHours: true });
    expect(wa.sent).toHaveLength(1);
    expect(wa.sent[0].text).toContain("https://maps.app.goo.gl/smile");
    expect((await owner.query("SELECT appointment_id FROM whatsapp_messages WHERE status='sent' AND clinic_id=$1", [s.clinicId])).rows[0].appointment_id).toBe(ac);
    // replying 1 asks NEPA to call and rebook
    const r = await receiveWhatsApp([inbound(s.business, "919811100005", "1")], { simulated: true });
    expect(r[0].result).toBe("booking call queued");
    expect(Number((await owner.query("SELECT count(*) FROM outbound_queue WHERE clinic_id=$1 AND patient_id=$2", [s.clinicId, pc])).rows[0].count)).toBe(1);
  });

  it("a template needing a missing link is not sent, and staff are told why", async () => {
    const s = await setup({ maps: false });
    const p = await patient(s.admin, "Noor Ali", "9811100007");
    const q = await queueWhatsApp(s.clinicId, { patientId: p, template: "no_show_location" });
    expect(q.reason).toMatch(/directions link/);
  });
});

describe("receiving", () => {
  it("STOP opts out, START opts back in, urgent words go to staff as urgent, unknown numbers are not stored against anyone", async () => {
    const s = await setup();
    const p = await patient(s.admin, "Farah Khan", "9811100008");
    let r = await receiveWhatsApp([inbound(s.business, "919811100008", "STOP")], { simulated: true });
    expect(r[0].result).toBe("opted out");
    expect((await owner.query("SELECT whatsapp_status FROM patients WHERE id=$1", [p])).rows[0].whatsapp_status).toBe("opted_out");
    r = await receiveWhatsApp([inbound(s.business, "919811100008", "start")], { simulated: true });
    expect(r[0].result).toBe("opted in");
    r = await receiveWhatsApp([inbound(s.business, "919811100008", "There is swelling and bleeding since morning")], { simulated: true });
    expect(r[0].result).toBe("urgent: told staff");
    const att = ok(await listAttention(s.admin, { view: "active", includeSimulated: true })).items.find((i) => i.kind === "whatsapp_reply" && i.patientId === p)!;
    expect(att.urgency).toBe(1);
    r = await receiveWhatsApp([inbound(s.business, "919999999999", "hello")], { simulated: true });
    expect(r[0].result).toBe("unknown sender: told staff");
    expect((await owner.query("SELECT patient_id FROM whatsapp_messages WHERE peer_number='919999999999'")).rows[0].patient_id).toBeNull();
    // messages to a number no clinic owns are dropped
    expect((await receiveWhatsApp([inbound("910000000000", "919811100008", "hi")]))[0].result).toBe("no clinic for number");
  });

  it("duplicate deliveries of the same message are ignored; receipts move forward only", async () => {
    const s = await setup();
    const p = await patient(s.admin, "Dev Mehta", "9811100009");
    const ev = inbound(s.business, "919811100009", "what time do you open?", "wamid.dup-1");
    expect((await receiveWhatsApp([ev, ev], { simulated: true })).map((x) => x.result)).toEqual(["reply: told staff", "duplicate"]);
    const q = await queueWhatsApp(s.clinicId, { patientId: p, template: "post_visit_checkin" });
    const ap = ok(await listApprovals(s.admin)).find((x) => x.action === "send_whatsapp")!;
    ok(await decideApproval(s.admin, ap.id, "approve", {}));
    await runWhatsApp(s.clinicId, { ignoreQuietHours: true });
    const pid = wa.sent[0].id;
    const at = new Date().toISOString();
    await receiveWhatsApp([{ type: "status", providerMessageId: pid, status: "read", at }, { type: "status", providerMessageId: pid, status: "delivered", at }]);
    expect((await owner.query("SELECT status FROM whatsapp_messages WHERE id=$1", [q.messageId])).rows[0].status).toBe("read");
  });

  it("the webhook route checks the signature and answers Meta's verification", async () => {
    const s = await setup();
    await patient(s.admin, "Sana Iyer", "9811100010");
    process.env.WHATSAPP_APP_SECRET = SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
    const { GET, POST } = await import("@/app/api/whatsapp/[provider]/route");
    const params = Promise.resolve({ provider: "simulated" });
    const get = await GET(new NextRequest("http://x/api/whatsapp/simulated?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"), { params });
    expect(await get.text()).toBe("42");
    expect((await GET(new NextRequest("http://x/api/whatsapp/simulated?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"), { params })).status).toBe(403);
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: s.business },
      messages: [{ id: "wamid.route-1", from: "919811100010", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Is parking available?" } }] } }] }] });
    const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    const bad = await POST(new NextRequest("http://x/api/whatsapp/simulated", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } }), { params });
    expect(bad.status).toBe(401);
    const good = await POST(new NextRequest("http://x/api/whatsapp/simulated", { method: "POST", body, headers: { "x-hub-signature-256": sig } }), { params });
    expect((await good.json()).results).toEqual([{ type: "message", result: "reply: told staff" }]);
  });
});

describe("staff conversations", () => {
  it("staff can reply within 24 hours of the patient's message; other clinics see nothing", async () => {
    const s = await setup();
    const p = await patient(s.admin, "Lata Joshi", "9811100011");
    expect((await staffReply(s.admin, p, "Hello")).ok).toBe(false);        // no message from the patient yet
    await receiveWhatsApp([inbound(s.business, "919811100011", "Can I come at 5?")], { simulated: true });
    expect(ok(await listConversations(s.admin)).find((x) => x.patientId === p)?.unhandled).toBe(1);
    ok(await staffReply(s.admin, p, "Yes, 5 pm is fine. See you then."));
    expect(wa.sent.at(-1)).toMatchObject({ text: "Yes, 5 pm is fine. See you then.", template: null });
    const conv = ok(await conversation(s.admin, p));
    expect(conv.messages.map((m) => m.direction)).toEqual(["in", "out"]);
    expect(conv.messages[1].status).toBe("sent");
    expect(ok(await listConversations(s.admin)).find((x) => x.patientId === p)?.unhandled).toBe(0);

    const other = await newClinic();
    expect((await conversation(other.admin, p)).ok).toBe(false);
    expect(ok(await listConversations(other.admin))).toHaveLength(0);
    await owner.query("UPDATE whatsapp_messages SET created_at = now() - interval '25 hours' WHERE patient_id = $1 AND direction = 'in'", [p]);
    expect((await staffReply(s.admin, p, "Are you coming?")).ok).toBe(false);
  });
});
