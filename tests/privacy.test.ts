// V2: clinic data policy — RedClinic access on request, and retention clean-up.
import { afterAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { userInfo } from "node:os";
import { closePool, withContext } from "@/lib/db";
import { login, resolveSession, contextOf } from "@/lib/auth/service";
import { clinicDetail } from "@/lib/admin/service";
import { decideGrant, getDataPolicy, requestAccess, runRetention, saveDataPolicy } from "@/lib/privacy/service";
import { getStorage, setStorage, type StorageAdapter } from "@/lib/storage";
import { freshOutbox, newClinic, newPatient, PASSWORD } from "./helpers";

const owner = process.env.TEST_DATABASE_ADMIN_URL
  ? new Pool({ connectionString: process.env.TEST_DATABASE_ADMIN_URL.replace(/\/[^/]*$/, "/rc_vitest") })
  : new Pool({ host: "/var/run/postgresql", database: "rc_vitest", user: userInfo().username });
afterAll(async () => { await closePool(); await owner.end(); });
const ok = <T,>(r: { ok: true; value: T } | { ok: false; error: string }): T => { if (!r.ok) throw new Error(r.error); return r.value; };

async function makeSuper() {
  const email = `super-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@redclinic.test`;
  const { hashPassword } = await import("@/lib/auth/password");
  const u = await owner.query("INSERT INTO users (role, email, display_name) VALUES ('super_admin',$1,'Support') RETURNING id", [email]);
  await owner.query("INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)", [u.rows[0].id, await hashPassword(PASSWORD)]);
  const s = await login(email, PASSWORD, { ip: null, userAgent: null });
  if (!s.ok) throw new Error(s.error);
  return (await resolveSession(s.value.token))!;
}
const policy = (o: Partial<Record<string, string>> = {}) => ({ superAccess: "full", recordingDays: "", transcriptDays: "", assistantLogDays: "", telephonyEventDays: "", ...o });

describe("RedClinic access to patient data", () => {
  it("full mode: the super admin sees the clinic's calls; request mode hides them until the clinic approves", async () => {
    const outbox = freshOutbox();
    const a = await newClinic();
    const su = await makeSuper();
    await owner.query("INSERT INTO calls (clinic_id, direction, status, summary, is_simulated) VALUES ($1,'inbound','completed','Asked about braces', true)", [a.clinicId]);

    expect(ok(await clinicDetail(su, a.clinicId)).calls).toHaveLength(1);

    ok(await saveDataPolicy(a.admin, policy({ superAccess: "request" })));
    let d = ok(await clinicDetail(su, a.clinicId));
    expect(d.access).toMatchObject({ mode: "request", open: false });
    expect(d.calls).toHaveLength(0);
    expect(d.counts.calls).toBe(0);              // simulated calls are not counted; the numbers still come through
    expect(d.counts.patients).toBeGreaterThanOrEqual(0);

    // the super admin cannot loosen the clinic's choice
    expect((await saveDataPolicy(su, policy())).ok).toBe(false);

    expect((await requestAccess(su, a.clinicId, { reason: "short", hours: 24 })).ok).toBe(false);
    const grantId = ok(await requestAccess(su, a.clinicId, { reason: "Checking a failed call for the clinic", hours: 24 }));
    expect(outbox.outbox.at(-1)?.to).toBe(a.adminEmail);
    expect((await requestAccess(su, a.clinicId, { reason: "Checking a failed call again", hours: 4 })).ok).toBe(false); // one at a time
    expect((await decideGrant(su, grantId, "approve")).ok).toBe(false);                                                 // only the clinic decides

    ok(await decideGrant(a.admin, grantId, "approve"));
    d = ok(await clinicDetail(su, a.clinicId));
    expect(d.access.open).toBe(true);
    expect(d.calls).toHaveLength(1);

    ok(await decideGrant(a.admin, grantId, "revoke"));
    expect(ok(await clinicDetail(su, a.clinicId)).calls).toHaveLength(0);

    const log = await withContext(contextOf(a.admin), async (c) => (await c.query("SELECT action FROM audit_log WHERE action LIKE 'super_access%' OR action = 'data_policy_saved'")).rows.map((r) => r.action));
    expect(log).toEqual(expect.arrayContaining(["data_policy_saved", "super_access_requested", "super_access_approved", "super_access_revoked"]));
  });

  it("staff without settings permission cannot change the policy", async () => {
    const a = await newClinic();
    const { addStaff } = await import("./helpers");
    const rec = await addStaff(a.admin, "receptionist", freshOutbox());
    expect((await saveDataPolicy(rec, policy({ superAccess: "request" }))).ok).toBe(false);
    expect((await getDataPolicy(rec)).ok).toBe(false);
  });
});

describe("retention", () => {
  it("validates choices and refuses keeping transcripts shorter than recordings", async () => {
    const a = await newClinic();
    expect((await saveDataPolicy(a.admin, policy({ recordingDays: "45" }))).ok).toBe(false);
    const r = await saveDataPolicy(a.admin, policy({ recordingDays: "180", transcriptDays: "90" }));
    expect(r.ok).toBe(false);
  });

  it("deletes expired recordings, transcripts and assistant logs; keeps recent ones and the patient record", async () => {
    const a = await newClinic();
    const patientId = await newPatient(a.admin);
    const removed: string[] = [];
    const real = getStorage();
    const fake: StorageAdapter = { driver: "test", put: async () => {}, get: async () => Buffer.alloc(0), remove: async (k) => { removed.push(k); }, signedUrl: () => "" };
    setStorage(fake);
    try {
      const old = (await owner.query(
        `INSERT INTO calls (clinic_id, patient_id, direction, status, is_simulated, started_at, recording_ref, recording_status, summary)
         VALUES ($1,$2,'inbound','completed',true, now() - interval '100 days', $3, 'stored', 'old call') RETURNING id`,
        [a.clinicId, patientId, `${a.clinicId}/recordings/old.wav`])).rows[0].id;
      const recent = (await owner.query(
        `INSERT INTO calls (clinic_id, patient_id, direction, status, is_simulated, started_at, recording_ref, recording_status)
         VALUES ($1,$2,'inbound','completed',true, now() - interval '2 days', $3, 'stored') RETURNING id`,
        [a.clinicId, patientId, `${a.clinicId}/recordings/new.wav`])).rows[0].id;
      for (const id of [old, recent]) await owner.query("INSERT INTO call_transcripts (call_id, clinic_id, seq, speaker, text_original) VALUES ($1,$2,1,'nepa','Hello')", [id, a.clinicId]);
      await owner.query("INSERT INTO assistant_interactions (clinic_id, user_id, question, answer, created_at) VALUES ($1,$2,'q','a', now() - interval '400 days')", [a.clinicId, a.admin.userId]);

      ok(await saveDataPolicy(a.admin, policy({ recordingDays: "30", transcriptDays: "90", assistantLogDays: "365" })));
      const runs = await runRetention();
      const mine = runs.find((x) => x.clinic === a.clinicId)!;
      expect(mine.result).toMatchObject({ recordings: 1, transcript_lines: 1, assistant_logs: 1 });
      expect(removed).toEqual([`${a.clinicId}/recordings/old.wav`]);

      const calls = (await owner.query("SELECT id, recording_ref, recording_status, summary FROM calls WHERE clinic_id = $1", [a.clinicId])).rows;
      expect(calls.find((c) => c.id === old)).toMatchObject({ recording_ref: null, recording_status: "deleted", summary: "old call" });
      expect(calls.find((c) => c.id === recent)?.recording_ref).not.toBeNull();
      expect(Number((await owner.query("SELECT count(*) FROM call_transcripts WHERE clinic_id = $1", [a.clinicId])).rows[0].count)).toBe(1);
      expect(Number((await owner.query("SELECT count(*) FROM patients WHERE id = $1", [patientId])).rows[0].count)).toBe(1);
      // not due again for 6 hours
      expect((await runRetention()).find((x) => x.clinic === a.clinicId)).toBeUndefined();
    } finally { setStorage(real); }
  });
});
