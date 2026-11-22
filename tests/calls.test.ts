import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { closePool } from "@/lib/db";
import { callBack, callerSays, correctTranscript, endCall, getCall, listCalls, queueOutbound, recordMissedCall, retryTranscription, runDialer, startCall, storeRecording } from "@/lib/calls/service";
import { ask } from "@/lib/assistant/service";
import { decideApproval, listApprovals } from "@/lib/nepa/approvals";
import { publishDraft, saveDraft } from "@/lib/nepa/config";
import { saveFaq, updateClinicProfile } from "@/lib/clinic/service";
import { getPatient, recordConsent, registerPatient, updateClinical } from "@/lib/patients/service";
import { getAppointment, bookAppointment } from "@/lib/appointments/service";
import { listAttention } from "@/lib/attention/service";
import { setStaffCapabilities } from "@/lib/staff/service";
import { SimulatedSpeechToText, setProviders } from "@/lib/providers";
import { addStaff, freshOutbox, newClinic } from "./helpers";

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
  ok(await updateClinicProfile(c.admin, { name: "Smile Dental", phone: "080 4000 1234", languages: ["en", "hi", "kn"], workingHours: ALL_WEEK }));
  ok(await saveFaq(c.admin, { question: "Do you have parking near the clinic?", answer: "Yes, free parking behind the building." }));
  return { ...c, doctor, recep };
}
async function patient(actor: Parameters<typeof registerPatient>[0], name: string, phone: string) {
  return (ok(await registerPatient(actor, { name, phone }, { confirmNew: true })) as { patientId: string }).patientId;
}

describe("inbound calls", () => {
  it("a full simulated call produces a complete record", async () => {
    const { clinicId, admin, recep } = await setup();
    await patient(recep, "Kavya Rao", "9845011111");
    const start = await startCall(clinicId, { direction: "inbound", callerNumber: "+91 98450 11111", simulated: true });
    expect(start.reply).toMatch(/AI receptionist/);
    const a = await callerSays(clinicId, start.callId, "Do you have parking?");
    expect(a.reply).toContain("free parking");
    const b = await callerSays(clinicId, start.callId, "No, thank you, bye");
    expect(b.ended).toBe(true);
    const call = ok(await getCall(admin, start.callId));
    expect(call).toMatchObject({ status: "completed", isSimulated: true, handledByNepa: true, handedToStaff: false, patientName: "Kavya Rao", intent: "faq" });
    expect(call.transcript!.map((t) => t.speaker)).toEqual(["nepa", "caller", "nepa", "caller", "nepa"]);
    expect(call.transcription.status).toBe("completed");
    expect(call.summary).toMatch(/question/i);
    expect(Object.keys(call.configVersions)).toEqual(expect.arrayContaining(["policies", "clinicConfig", "agentConfig"]));
    expect(call.durationSeconds).toBeGreaterThan(0);
    const usage = (await owner.query("SELECT kind, sum(quantity)::int q FROM usage_events WHERE clinic_id = $1 GROUP BY kind ORDER BY kind", [clinicId])).rows;
    expect(usage).toEqual([{ kind: "call", q: 1 }, { kind: "voice_seconds", q: call.durationSeconds }]);
    // simulated calls are hidden from the normal call list
    expect(ok(await listCalls(admin))).toHaveLength(0);
    expect(ok(await listCalls(admin, { includeSimulated: true }))).toHaveLength(1);
  });

  it("an emergency is escalated at once, urgently", async () => {
    const { clinicId, recep } = await setup();
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000001", simulated: true });
    const r = await callerSays(clinicId, s.callId, "My husband fainted and is not breathing");
    expect(r).toMatchObject({ ended: true, handedOff: true });
    expect(r.reply).toMatch(/108 or 112/);
    const items = ok(await listAttention(recep, { includeSimulated: true })).items;
    expect(items[0]).toMatchObject({ kind: "call_handed_over", urgency: 1, isSimulated: true });
    expect(ok(await getCall(recep, s.callId)).status).toBe("handed_to_staff");
  });

  it("a caller who hangs up mid-way leaves a callback item", async () => {
    const { clinicId, recep } = await setup();
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000002", simulated: true });
    await callerSays(clinicId, s.callId, "Hello");
    await endCall(clinicId, s.callId, "caller_hung_up");
    expect(ok(await listAttention(recep, { includeSimulated: true })).items.map((i) => i.kind)).toContain("call_not_completed");
    await expect(callerSays(clinicId, s.callId, "still there?")).rejects.toThrow(/ended/);
  });

  it("a switched-off agent takes no calls", async () => {
    const { clinicId } = await setup();
    await owner.query("UPDATE nepa_agents SET enabled = false WHERE clinic_id = $1 AND kind = 'receptionist'", [clinicId]);
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000003", simulated: true });
    expect(s).toMatchObject({ ended: true, handedOff: true, reply: "" });
    expect((await owner.query("SELECT status FROM calls WHERE id = $1", [s.callId])).rows[0].status).toBe("handed_to_staff");
  });
});

describe("missed calls and the outgoing queue", () => {
  it("missed call → callback needs approval → dialler calls once approved, linked to the missed call", async () => {
    const { clinicId, admin, recep } = await setup();
    await patient(recep, "Missed Caller", "9811122222");
    const missed = await recordMissedCall(clinicId, "9811122222", { simulated: false });
    expect(ok(await listAttention(recep)).items[0].reason).toMatch(/Missed call from 9811122222 \(Missed Caller\)/);
    const q = ok(await callBack(recep, missed));
    expect(q.mode).toBe("approval_required");
    expect(await runDialer(clinicId, { ignoreQuietHours: true })).toEqual([]); // not approved yet
    const ap = ok(await listApprovals(admin)).find((a) => a.action === "outbound_call")!;
    ok(await decideApproval(admin, ap.id, "approve"));
    const placed = await runDialer(clinicId, { ignoreQuietHours: true, simulateConversation: ["bye"] });
    expect(placed).toHaveLength(1);
    const call = ok(await getCall(admin, placed[0]));
    expect(call).toMatchObject({ direction: "outbound", purpose: "callback", callbackOf: missed, status: "completed" });
    expect(call.transcript![0].original).toMatch(/missed your call/);
  });

  it("confirmation call confirms the appointment when the patient says yes", async () => {
    const { clinicId, admin, recep, doctor } = await setup();
    const pid = await patient(recep, "Confirm Me", "9822233333");
    const day = new Date(Date.now() + 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);
    const appt = ok(await bookAppointment(recep, { patientId: pid, doctorId: doctor.userId, date: day, time: "11:00" }));
    // the clinic lets NEPA do reminders through an automatic workflow
    const wf = (await owner.query("SELECT id FROM clinic_workflows WHERE clinic_id = $1 LIMIT 1", [clinicId])).rows[0].id;
    await owner.query("UPDATE clinic_workflows SET enabled = true, automatic_enabled = true WHERE id = $1", [wf]);
    ok(await saveDraft(admin, null, { permissions: { send_reminder: "automatic" } })); ok(await publishDraft(admin, null));
    await owner.query("UPDATE nepa_agents SET enabled = true WHERE clinic_id = $1 AND kind = 'reminder'", [clinicId]);
    const q = await queueOutbound(clinicId, { patientId: pid, purpose: "confirmation", appointmentId: appt, workflowId: wf });
    expect(q.mode).toBe("automatic");
    const [callId] = await runDialer(clinicId, { ignoreQuietHours: true, simulateConversation: ["Yes, I will come"] });
    expect(ok(await getAppointment(recep, appt)).status).toBe("confirmed");
    const call = ok(await getCall(admin, callId));
    expect(call.transcript![0].original).toMatch(/calling about your appointment/);
    expect(call.outcome).toBe("confirmed");
  });

  it("an outgoing call is skipped while its agent is switched off", async () => {
    const { clinicId, admin, recep } = await setup();
    const pid = await patient(recep, "Agent Off", "9877788888");
    await queueOutbound(clinicId, { patientId: pid, purpose: "recall" }); // reminder agent is off by default
    const ap = ok(await listApprovals(admin))[0]; ok(await decideApproval(admin, ap.id, "approve"));
    expect(await runDialer(clinicId, { ignoreQuietHours: true })).toEqual([]);
    expect((await owner.query("SELECT status, last_error FROM outbound_queue WHERE patient_id = $1", [pid])).rows[0]).toEqual({ status: "skipped", last_error: "The reminder agent is switched off." });
  });

  it("no calls to patients who withdrew consent", async () => {
    const { clinicId, recep } = await setup();
    const pid = await patient(recep, "No Calls", "9833344444");
    ok(await recordConsent(recep, pid, { status: "withdrawn", method: "verbal" }));
    const q = await queueOutbound(clinicId, { patientId: pid, purpose: "recall" });
    expect(q.mode).toBe("prohibited");
    expect(await runDialer(clinicId, { ignoreQuietHours: true })).toEqual([]);
  });

  it("the dialler respects quiet hours", async () => {
    const { clinicId, admin, recep } = await setup();
    const pid = await patient(recep, "Late Night", "9844455555");
    await owner.query("UPDATE nepa_agents SET enabled = true WHERE clinic_id = $1 AND kind = 'reminder'", [clinicId]);
    const q = await queueOutbound(clinicId, { patientId: pid, purpose: "recall" });
    const ap = ok(await listApprovals(admin))[0]; ok(await decideApproval(admin, ap.id, "approve"));
    const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hourCycle: "h23", timeZone: "Asia/Kolkata" }).format(new Date()));
    const placed = await runDialer(clinicId);
    expect(placed.length).toBe(hour >= 9 && hour < 21 ? 1 : 0);
    void q;
  });
});

describe("transcripts", () => {
  it("corrections are kept beside the original", async () => {
    const { clinicId, doctor: recep } = await setup(); // doctors can read and correct transcripts by default
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000004", simulated: true });
    await callerSays(clinicId, s.callId, "Do you have parkin?");
    await endCall(clinicId, s.callId, "completed");
    const seg = ok(await getCall(recep, s.callId)).transcript![1];
    ok(await correctTranscript(recep, seg.id, "Do you have parking?"));
    const after = ok(await getCall(recep, s.callId)).transcript![1];
    expect(after).toMatchObject({ original: "Do you have parkin?", corrected: "Do you have parking?", correctedBy: "Test doctor" });
    await expect(owner.query("SET ROLE rc_app; UPDATE call_transcripts SET text_original = 'x' WHERE id = $1", [seg.id]).finally(() => owner.query("RESET ROLE"))).rejects.toThrow();
  });

  it("transcription failure is recorded and can be retried; nothing is invented", async () => {
    const { clinicId, admin } = await setup();
    const stt = new SimulatedSpeechToText(); stt.failNext = 1; setProviders({ stt });
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000005", simulated: false });
    await endCall(clinicId, s.callId, "caller_hung_up", { durationSeconds: 30 });
    await storeRecording(clinicId, s.callId, Buffer.from("RIFF....WAVEfmt "));
    const { transcribeRecording } = await import("@/lib/calls/service");
    expect(await transcribeRecording(clinicId, s.callId)).toBe("failed");
    let call = ok(await getCall(admin, s.callId));
    expect(call.transcription).toMatchObject({ status: "failed", attempts: 1, error: "Simulated transcription failure" });
    expect(call.recording).toMatchObject({ status: "stored", format: "wav-pcm16-16khz-2ch", hasFile: true });
    expect(ok(await retryTranscription(admin, s.callId))).toBe("completed");
    call = ok(await getCall(admin, s.callId));
    expect(call.transcription.attempts).toBe(2);
    expect(call.transcript!.length).toBe(1); // only NEPA's opening line; the simulated recogniser adds nothing it didn't hear
  });

  it("staff without call permission see nothing; transcripts need their own permission", async () => {
    const { clinicId, admin, recep } = await setup();
    const s = await startCall(clinicId, { direction: "inbound", callerNumber: "9000000006", simulated: false });
    await endCall(clinicId, s.callId, "completed");
    ok(await setStaffCapabilities(admin, recep.userId, ["view_patients", "view_calls"]));
    expect(ok(await getCall(recep, s.callId)).transcript).toBeNull();
    ok(await setStaffCapabilities(admin, recep.userId, ["view_patients"]));
    expect((await listCalls(recep)).ok).toBe(false);
    expect((await getCall(recep, s.callId)).ok).toBe(false);
  });
});

describe("telephony webhook", () => {
  const sign = (body: string) => createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
  async function post(body: object, sig?: string) {
    const raw = JSON.stringify(body);
    const { POST } = await import("@/app/api/telephony/[provider]/route");
    const req = new NextRequest("http://localhost/api/telephony/simulated", { method: "POST", body: raw, headers: { "x-signature": sig ?? sign(raw) } });
    const res = await POST(req, { params: Promise.resolve({ provider: "simulated" }) });
    return { status: res.status, body: await res.json() };
  }
  it("checks signatures, ignores duplicates and runs the call", async () => {
    const { clinicId, admin } = await setup();
    await owner.query("INSERT INTO clinic_phone_numbers (clinic_id, clinic_number, receptionist_number, status) VALUES ($1,'08040001234','+91 80 6000 0001','verified')", [clinicId]);
    const base = { providerCallId: `pc-${clinicId}`, to: "08060000001", from: "9876543210", direction: "inbound", at: new Date().toISOString() };
    expect((await post({ ...base, eventId: "e0", type: "call.started" }, "bad")).status).toBe(401);
    const started = await post({ ...base, eventId: `e1-${clinicId}`, type: "call.started" });
    expect(started.body.say).toMatch(/AI receptionist/);
    expect((await post({ ...base, eventId: `e1-${clinicId}`, type: "call.started" })).body).toEqual({ duplicate: true });
    const said = await post({ ...base, eventId: `e2-${clinicId}`, type: "call.speech", text: "Is there parking?" });
    expect(said.body.say).toContain("free parking");
    await post({ ...base, eventId: `e3-${clinicId}`, type: "call.ended", durationSeconds: 42 });
    const calls = ok(await listCalls(admin, { includeSimulated: true }));
    expect(calls[0]).toMatchObject({ status: "completed", durationSeconds: 42 });
    expect((await post({ ...base, to: "08099999999", eventId: `e4-${clinicId}`, type: "call.started" })).status).toBe(404);
  });
});

describe("in-app assistant", () => {
  it("summarises a patient with linked sources and says what is not recorded", async () => {
    const { admin, recep, doctor } = await setup();
    const pid = await patient(recep, "Lakshmi Menon", "9855566666");
    ok(await updateClinical(doctor, pid, { allergies: "Penicillin" }));
    const code = ok(await getPatient(doctor, pid)).code;
    const a = ok(await ask(doctor, `Summary of ${code}`));
    expect(a.lines.find((l) => l.text.startsWith("Allergies"))).toMatchObject({ text: "Allergies: Penicillin", source: { href: `/patients/${pid}` } });
    expect(a.lines.find((l) => l.text.startsWith("Medical history"))!.unavailable).toBe(true);
    expect(a.sources.length).toBeGreaterThan(0);
    const r = ok(await ask(recep, "tell me about Lakshmi Menon"));
    expect(r.lines.find((l) => l.text.startsWith("Medical history"))!.text).toMatch(/permission/);
    const logged = (await owner.query("SELECT config_versions FROM assistant_interactions WHERE user_id = $1", [doctor.userId])).rows;
    expect(logged[0].config_versions.policies).toBeTruthy();
    void admin;
  });

  it("refuses medical advice, asks when names are ambiguous, and drafts notes only for approval", async () => {
    const { doctor, recep, admin } = await setup();
    await patient(recep, "Arun Kumar", "9866600001");
    await patient(recep, "Arun Kumaar", "9866600002");
    expect(ok(await ask(doctor, "What antibiotic should I prescribe for Arun Kumar?")).answer).toMatch(/can't diagnose, prescribe/);
    expect(ok(await ask(doctor, "summary of Arun Kumar")).answer).toMatch(/more than one/i);
    const d = ok(await ask(doctor, "draft note for 9866600001: Review in 2 weeks"));
    expect(d.answer).toMatch(/only after someone approves/);
    const ap = ok(await listApprovals(admin)).find((x) => x.action === "draft_note")!;
    ok(await decideApproval(admin, ap.id, "approve"));
    const pid = ap.patientId!;
    expect(ok(await getPatient(doctor, pid)).clinical!.notes).toMatch(/Review in 2 weeks/);
  });
});
