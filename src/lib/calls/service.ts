// Calls: the live call lifecycle (NEPA side), the outgoing queue, transcripts, and what staff see.
// Live calls run in a clinic-only context (no user), like a real phone call arriving from the provider.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { withContext, type DbContext } from "../db";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, requireCap, UserError } from "../authz";
import { resolve } from "../nepa/resolver";
import { decideOutbound } from "../nepa/tools";
import { getModel, newConversation, type ConversationState, type Lang } from "../nepa/engine";
import { getSpeechToText, getSummarizer, getTelephony } from "../providers";
import { getStorage } from "../storage";

const clinicCtx = (clinicId: string): DbContext => ({ userId: null, clinicId, isSuperAdmin: false });
const now = () => new Date();

export interface LiveTurnResult { callId: string; reply: string; ended: boolean; handedOff: boolean; outcome: string | null }

async function saveState(c: PoolClient, callId: string, s: ConversationState, fromSeq: number) {
  const newTurns = s.turns.slice(fromSeq);
  for (const [i, t] of newTurns.entries()) {
    await c.query(
      "INSERT INTO call_transcripts (clinic_id, call_id, seq, speaker, language, text_original, at_ms) VALUES (rc_clinic_id(),$1,$2,$3,$4,$5,$6)",
      [callId, fromSeq + i, t.speaker, t.lang, t.text, t.atMs]);
  }
  await c.query("UPDATE calls SET engine_state = $2, language = $3, intent = $4, outcome = $5 WHERE id = $1",
    [callId, JSON.stringify(s), s.lang, s.intent, s.outcome]);
}

function revive(state: unknown): ConversationState {
  const s = state as ConversationState;
  if (s.patient?.nextAt) s.patient.nextAt = new Date(s.patient.nextAt);
  return s;
}

/** A call starts (inbound from a caller, or outbound placed by the queue). NEPA speaks first. */
export async function startCall(clinicId: string, input: {
  direction: "inbound" | "outbound"; callerNumber: string | null; simulated: boolean; testCall?: boolean; agentKind?: string;
  provider?: string; providerCallId?: string; purpose?: string; patientId?: string | null; appointmentId?: string | null;
  workflowId?: string | null; approvalId?: string | null; callbackOf?: string | null; lang?: Lang;
}): Promise<LiveTurnResult> {
  const result = await withContext(clinicCtx(clinicId), async (c) => {
    const agentKind = input.agentKind ?? (input.direction === "inbound" ? "receptionist" : "reminder");
    const r = await resolve(c, agentKind);
    if (r.agent && !r.agent.enabled && input.direction === "outbound") throw new AgentOff(`The ${agentKind.replace("_", " ")} agent is switched off.`);
    const callId = randomUUID();
    await c.query(
      `INSERT INTO calls (id, clinic_id, direction, is_simulated, test_call, caller_number, started_at, status, handled_by_nepa, transcription_status,
                          config_versions, agent_id, provider, provider_call_id, purpose, patient_id, appointment_id, workflow_id, approval_id, callback_of,
                          recording_status, recording_format)
       VALUES ($1, rc_clinic_id(), $2, $3, $4, $5, now(), 'in_progress', true, 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [callId, input.direction, input.simulated, !!input.testCall, input.callerNumber, r.versions, r.agent?.id ?? null,
       input.provider ?? "simulated", input.providerCallId ?? null, input.purpose ?? null, input.patientId ?? null,
       input.appointmentId ?? null, input.workflowId ?? null, input.approvalId ?? null, input.callbackOf ?? null,
       input.simulated ? "none" : "recording", input.simulated ? null : "wav-pcm16-16khz-2ch"]);
    if (r.agent && !r.agent.enabled) {
      // inbound call while the receptionist is off: straight to staff
      const s = newConversation(input.callerNumber, input.lang ?? "en");
      s.ended = true; s.handedOff = true; s.outcome = "handed_to_staff";
      await saveState(c, callId, s, 0);
      return { callId, reply: "", ended: true, handedOff: true, outcome: s.outcome };
    }
    const t = { c, r, callId, simulated: input.simulated };
    let s = newConversation(input.callerNumber, input.lang ?? (r.clinicConfig.preferredLanguage as Lang));
    if (input.direction === "outbound" && input.purpose) s.intent = input.purpose === "reminder" ? "confirmation" : input.purpose;
    const out = await getModel().next(t, s, null);
    s = out.state;
    if (s.patient?.patientId) await c.query("UPDATE calls SET patient_id = coalesce(patient_id, $2) WHERE id = $1", [callId, s.patient.patientId]);
    await saveState(c, callId, s, 0);
    return { callId, reply: out.reply, ended: s.ended, handedOff: s.handedOff, outcome: s.outcome };
  });
  if (result.ended) await endCall(clinicId, result.callId, result.handedOff ? "handed_over" : "completed");
  return result;
}

export class AgentOff extends Error {}

/** The caller says something (from the provider's live speech recognition, or typed in test mode). */
export async function callerSays(clinicId: string, callId: string, text: string): Promise<LiveTurnResult> {
  const result = await withContext(clinicCtx(clinicId), async (c) => {
    const call = (await c.query("SELECT * FROM calls WHERE id = $1 FOR UPDATE", [callId])).rows[0];
    if (!call) throw new UserError("Call not found.");
    if (call.status !== "in_progress") throw new UserError("This call has ended.");
    const agentKind = call.agent_id ? (await c.query("SELECT kind FROM nepa_agents WHERE id = $1", [call.agent_id])).rows[0]?.kind : "receptionist";
    const r = await resolve(c, agentKind);
    const s = revive(call.engine_state);
    const before = s.turns.length;
    const out = await getModel().next({ c, r, callId, simulated: call.is_simulated }, s, text.slice(0, 1000));
    if (out.state.patient?.patientId) await c.query("UPDATE calls SET patient_id = coalesce(patient_id, $2) WHERE id = $1", [callId, out.state.patient.patientId]);
    await saveState(c, callId, out.state, before);
    return { callId, reply: out.reply, ended: out.state.ended, handedOff: out.state.handedOff, outcome: out.state.outcome };
  });
  if (result.ended) await endCall(clinicId, callId, result.handedOff ? "handed_over" : "completed");
  return result;
}

/** Ends a call and fills in the record: times, status, summary, follow-up, actions, usage. */
export async function endCall(clinicId: string, callId: string, how: "completed" | "handed_over" | "caller_hung_up" | "failed", info: { durationSeconds?: number } = {}) {
  return withContext(clinicCtx(clinicId), async (c) => {
    const call = (await c.query("SELECT * FROM calls WHERE id = $1 FOR UPDATE", [callId])).rows[0];
    if (!call || call.status !== "in_progress") return;
    const s = revive(call.engine_state ?? newConversation(call.caller_number));
    const started = new Date(call.started_at).getTime();
    const duration = info.durationSeconds ?? (call.is_simulated ? Math.max(5, s.turns.length * 6) : Math.round((Date.now() - started) / 1000));
    const handed = how === "handed_over" || s.handedOff;
    const status = how === "failed" ? "failed" : handed ? "handed_to_staff" : "completed";
    const summary = await getSummarizer().summarize({ turns: s.turns, intent: s.intent, outcome: s.outcome ?? (how === "caller_hung_up" ? "ended_by_caller" : null), lang: s.lang });
    const followUp = handed || ["callback_needed", "booking_requested", "request_sent", "action_failed"].includes(s.outcome ?? "")
      ? "Staff to follow up (see Needs attention)." : null;
    const transcriptionStatus = s.turns.length ? "completed" : "unavailable"; // live calls are transcribed as they happen
    await c.query(
      `UPDATE calls SET status=$2, ended_at = started_at + make_interval(secs => $3), duration_seconds=$3, handed_to_staff=$4,
              summary=$5, follow_up=$6, actions_executed=$7, outcome=coalesce(outcome, $8), transcription_status=$9,
              engine_state = NULL, transcription_provider = 'live'
       WHERE id = $1`,
      [callId, status, duration, handed, summary, followUp, JSON.stringify(s.actions), how === "caller_hung_up" ? "ended_by_caller" : null, transcriptionStatus]);
    // a call that stopped half-way gets a callback item
    if (how === "caller_hung_up" && s.turns.filter((t) => t.speaker === "caller").length > 0 && !s.outcome) {
      await c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, call_id, reason, urgency, is_simulated)
                     VALUES (rc_clinic_id(), 'call_not_completed', $1, $2, 'The caller hung up before NEPA could help.', 2, $3) ON CONFLICT DO NOTHING`,
        [call.patient_id, callId, call.is_simulated]);
    }
    if (how === "failed" && call.direction === "outbound") {
      await c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, call_id, reason, urgency, is_simulated)
                     VALUES (rc_clinic_id(), 'failed_outbound_call', $1, $2, 'NEPA\'s call did not go through.', 2, $3) ON CONFLICT DO NOTHING`,
        [call.patient_id, callId, call.is_simulated]);
    }
    await c.query("INSERT INTO usage_events (clinic_id, kind, quantity, is_simulated) VALUES (rc_clinic_id(), 'voice_seconds', $1, $2), (rc_clinic_id(), 'call', 1, $2)", [duration, call.is_simulated]);
    await c.query("UPDATE outbound_queue SET status = $2 WHERE call_id = $1 AND status = 'calling'", [callId, how === "failed" ? "failed" : "done"]);
  });
}

/** Nobody answered (the provider reports a missed inbound call). Staff get a callback item. */
export async function recordMissedCall(clinicId: string, callerNumber: string, opts: { simulated: boolean; provider?: string; providerCallId?: string }) {
  return withContext(clinicCtx(clinicId), async (c) => {
    const callId = randomUUID();
    const caller = (await c.query("SELECT patient_id, name FROM rc_nepa_find_caller($1)", [callerNumber])).rows;
    const patientId = caller.length === 1 ? caller[0].patient_id : null;
    await c.query(
      `INSERT INTO calls (id, clinic_id, direction, is_simulated, caller_number, started_at, ended_at, duration_seconds, status, handled_by_nepa,
                          transcription_status, provider, provider_call_id, patient_id, summary)
       VALUES ($1, rc_clinic_id(), 'inbound', $2, $3, now(), now(), 0, 'missed', false, 'unavailable', $4, $5, $6, 'Missed call.')`,
      [callId, opts.simulated, callerNumber, opts.provider ?? "simulated", opts.providerCallId ?? null, patientId]);
    await c.query(
      `INSERT INTO attention_items (clinic_id, kind, patient_id, call_id, reason, urgency, is_simulated)
       VALUES (rc_clinic_id(), 'call_not_completed', $1, $2, $3, 2, $4)`,
      [patientId, callId, `Missed call from ${callerNumber}${caller.length === 1 ? ` (${caller[0].name})` : ""}. Call back.`, opts.simulated]);
    return callId;
  });
}

// ---------- outgoing calls ----------
/** Adds an outgoing call to the queue, after the permission engine decides whether it needs approval. */
export async function queueOutbound(clinicId: string, input: { patientId: string; purpose: string; appointmentId?: string | null; workflowId?: string | null; callbackOf?: string | null; dueAt?: Date; simulated?: boolean; agentKind?: string; summary?: string }) {
  return withContext(clinicCtx(clinicId), async (c) => {
    const p = (await c.query("SELECT * FROM rc_nepa_patient_brief($1)", [input.patientId])).rows[0];
    if (!p) throw new UserError("Patient not found.");
    const agentKind = input.agentKind ?? "reminder";
    const r = await resolve(c, agentKind);
    const kind = ["confirmation", "reminder"].includes(input.purpose) ? "send_reminder" : "outbound_call";
    const d = await decideOutbound({ c, r, callId: null, simulated: !!input.simulated }, kind, input.workflowId ?? null, p.consent_status);
    const id = randomUUID();
    if (d.mode === "prohibited" || d.mode === "suggest") {
      // no call: withdrawn consent, or NEPA may only suggest
      await c.query(`INSERT INTO outbound_queue (id, clinic_id, patient_id, appointment_id, purpose, agent_kind, workflow_id, callback_of, due_at, status, last_error, is_simulated)
                     VALUES ($1, rc_clinic_id(), $2, $3, $4, $5, $6, $7, coalesce($8, now()), 'skipped', $9, $10) ON CONFLICT DO NOTHING`,
        [id, input.patientId, input.appointmentId ?? null, input.purpose, agentKind, input.workflowId ?? null, input.callbackOf ?? null, input.dueAt ?? null, d.reason, !!input.simulated]);
      return { queueId: id, mode: d.mode, reason: d.reason };
    }
    let approvalId: string | null = null;
    if (d.mode === "approval_required") {
      approvalId = randomUUID();
      await c.query(`INSERT INTO approvals (id, clinic_id, requested_by, action_type, details, mode, status, agent_id, patient_id, summary)
                     VALUES ($1, rc_clinic_id(), $2, $3, $4, 'approval_required', 'pending', $5, $6, $7)`,
        [approvalId, `nepa:${agentKind}`, kind, { queueId: id, purpose: input.purpose, appointmentId: input.appointmentId ?? null },
         r.agent?.id ?? null, input.patientId, input.summary ?? `Call ${p.name} (${input.purpose.replace(/_/g, " ")})`]);
      await c.query(`INSERT INTO attention_items (clinic_id, kind, patient_id, approval_id, reason, urgency, is_simulated)
                     VALUES (rc_clinic_id(), 'pending_approval', $1, $2, $3, 3, $4) ON CONFLICT DO NOTHING`,
        [input.patientId, approvalId, `NEPA asks to call ${p.name}: ${input.purpose.replace(/_/g, " ")}`, !!input.simulated]);
    }
    const ins = await c.query(
      `INSERT INTO outbound_queue (id, clinic_id, patient_id, appointment_id, purpose, agent_kind, workflow_id, approval_id, callback_of, due_at, status, is_simulated)
       VALUES ($1, rc_clinic_id(), $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()), $10, $11) ON CONFLICT DO NOTHING`,
      [id, input.patientId, input.appointmentId ?? null, input.purpose, agentKind, input.workflowId ?? null, approvalId, input.callbackOf ?? null,
       input.dueAt ?? null, approvalId ? "awaiting_approval" : "queued", !!input.simulated]);
    return { queueId: ins.rowCount ? id : null, mode: d.mode, reason: d.reason };
  });
}

/**
 * Places due calls. Run every minute by the scheduler (or "Run now" in test mode). Approved calls move from
 * awaiting_approval to queued here. Respects opening hours for patient calls (no calls 9 pm–9 am).
 */
export async function runDialer(clinicId: string, opts: { simulateConversation?: string[]; ignoreQuietHours?: boolean } = {}) {
  const due = await withContext(clinicCtx(clinicId), async (c) => {
    await c.query("SELECT rc_outbound_sync_approvals()");
    const hour = Number((await c.query("SELECT extract(hour from now() AT TIME ZONE timezone) AS h FROM clinics WHERE id = rc_clinic_id()")).rows[0].h);
    if (!opts.ignoreQuietHours && (hour < 9 || hour >= 21)) return [];
    const r = await c.query(
      `UPDATE outbound_queue SET status = 'calling', attempts = attempts + 1
       WHERE id IN (SELECT id FROM outbound_queue WHERE status = 'queued' AND due_at <= now() ORDER BY due_at LIMIT 20 FOR UPDATE SKIP LOCKED)
       RETURNING *`);
    const out = [];
    for (const q of r.rows) {
      const p = (await c.query("SELECT * FROM rc_nepa_patient_brief($1)", [q.patient_id])).rows[0];
      if (!p?.phone || p.consent_status === "withdrawn") {
        await c.query("UPDATE outbound_queue SET status = 'skipped', last_error = $2 WHERE id = $1", [q.id, !p?.phone ? "No phone number" : "Consent withdrawn"]);
        continue;
      }
      out.push({ ...q, phone: p.phone });
    }
    return out;
  });
  const placed: string[] = [];
  for (const q of due) {
    try {
      const call = await startCall(clinicId, {
        direction: "outbound", callerNumber: q.phone, simulated: q.is_simulated || getTelephony().info.simulated, agentKind: q.agent_kind,
        purpose: q.purpose, patientId: q.patient_id, appointmentId: q.appointment_id, workflowId: q.workflow_id, approvalId: q.approval_id, callbackOf: q.callback_of,
      });
      await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE outbound_queue SET call_id = $2 WHERE id = $1", [q.id, call.callId]));
      await getTelephony().placeCall({ to: q.phone, from: "", clinicId, callId: call.callId });
      placed.push(call.callId);
      if (opts.simulateConversation) {
        let res = call;
        for (const line of opts.simulateConversation) { if (res.ended) break; res = await callerSays(clinicId, call.callId, line); }
        if (!res.ended) await endCall(clinicId, call.callId, "completed");
      }
    } catch (e) {
      if (e instanceof AgentOff) {
        await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE outbound_queue SET status = 'skipped', last_error = $2 WHERE id = $1", [q.id, e.message]));
        continue;
      }
      await withContext(clinicCtx(clinicId), (c) => c.query("UPDATE outbound_queue SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, due_at = now() + interval '30 minutes', last_error = $2 WHERE id = $1", [q.id, (e as Error).message]));
    }
  }
  return placed;
}

// ---------- transcripts of recorded calls ----------
/** Transcribes a stored recording (real calls). On failure the status says so, and staff can retry. Never invents text. */
export async function transcribeRecording(clinicId: string, callId: string) {
  return withContext(clinicCtx(clinicId), async (c) => {
    const call = (await c.query("SELECT * FROM calls WHERE id = $1 FOR UPDATE", [callId])).rows[0];
    if (!call) throw new UserError("Call not found.");
    if (!call.recording_ref) {
      await c.query("UPDATE calls SET transcription_status = 'unavailable', transcription_error = 'No recording stored' WHERE id = $1", [callId]);
      return "unavailable";
    }
    await c.query("UPDATE calls SET transcription_attempts = transcription_attempts + 1, transcription_status = 'pending' WHERE id = $1", [callId]);
    try {
      const audio = await getStorage().get(call.recording_ref);
      const r = await resolve(c, "receptionist");
      const segs = await getSpeechToText().transcribe({ audio, format: call.recording_format ?? "wav", languages: r.languages });
      const start = (await c.query("SELECT coalesce(max(seq)+1, 0) AS n FROM call_transcripts WHERE call_id = $1", [callId])).rows[0].n;
      for (const [i, s] of segs.entries()) {
        await c.query("INSERT INTO call_transcripts (clinic_id, call_id, seq, speaker, language, text_original, at_ms) VALUES (rc_clinic_id(),$1,$2,$3,$4,$5,$6)",
          [callId, start + i, s.speaker, s.lang, s.text, s.atMs]);
      }
      await c.query("UPDATE calls SET transcription_status = 'completed', transcription_error = NULL, transcription_provider = $2 WHERE id = $1", [callId, getSpeechToText().info.name]);
      return "completed";
    } catch (e) {
      await c.query("UPDATE calls SET transcription_status = 'failed', transcription_error = $2 WHERE id = $1", [callId, (e as Error).message.slice(0, 300)]);
      return "failed";
    }
  });
}

/** Stores a recording for a call (two-track WAV kept as the original). */
export async function storeRecording(clinicId: string, callId: string, wav: Buffer, format = "wav-pcm16-16khz-2ch") {
  const key = `${clinicId}/${callId}/${randomUUID()}.wav`;
  return withContext(clinicCtx(clinicId), async (c) => {
    await getStorage().put(key, wav, "audio/wav");
    await c.query("UPDATE calls SET recording_ref = $2, recording_status = 'stored', recording_format = $3 WHERE id = $1", [callId, key, format]);
    return key;
  });
}

// ---------- what staff see ----------
export interface CallSummary {
  id: string; direction: string; status: string; isSimulated: boolean; testCall: boolean; callerNumber: string | null;
  startedAt: Date; durationSeconds: number | null; patientId: string | null; patientName: string | null;
  intent: string | null; outcome: string | null; summary: string | null; purpose: string | null; handedToStaff: boolean;
}

export async function listCalls(actor: SignedInUser, f: { direction?: string; status?: string; includeSimulated?: boolean; patientId?: string; limit?: number } = {}) {
  return act(actor, async (c) => {
    await requireCap(c, "view_calls", "You don't have access to calls.");
    const where = ["true"]; const args: unknown[] = [];
    if (!f.includeSimulated) where.push("NOT c.is_simulated");
    if (f.direction) { args.push(f.direction); where.push(`c.direction = $${args.length}`); }
    if (f.status) { args.push(f.status); where.push(`c.status = $${args.length}`); }
    if (f.patientId) { args.push(f.patientId); where.push(`c.patient_id = $${args.length}`); }
    args.push(Math.min(f.limit ?? 100, 300));
    const r = await c.query(
      `SELECT c.*, p.name AS patient_name FROM calls c LEFT JOIN patients p ON p.id = c.patient_id
       WHERE ${where.join(" AND ")} ORDER BY c.started_at DESC LIMIT $${args.length}`, args);
    return r.rows.map((x): CallSummary => ({
      id: x.id, direction: x.direction, status: x.status, isSimulated: x.is_simulated, testCall: x.test_call, callerNumber: x.caller_number,
      startedAt: x.started_at, durationSeconds: x.duration_seconds, patientId: x.patient_id, patientName: x.patient_name,
      intent: x.intent, outcome: x.outcome, summary: x.summary, purpose: x.purpose, handedToStaff: x.handed_to_staff,
    }));
  });
}

export async function getCall(actor: SignedInUser, id: string) {
  return act(actor, async (c) => {
    if (!z.string().uuid().safeParse(id).success) throw new UserError("Call not found.");
    await requireCap(c, "view_calls", "You don't have access to calls.");
    const x = (await c.query("SELECT c.*, p.name AS patient_name, p.patient_code FROM calls c LEFT JOIN patients p ON p.id = c.patient_id WHERE c.id = $1", [id])).rows[0];
    if (!x) throw new UserError("Call not found.");
    const canTranscript = await can(c, "view_call_transcripts");
    const transcript = canTranscript ? (await c.query(
      `SELECT t.id, t.seq, t.speaker, t.language, t.text_original, t.text_corrected, t.at_ms, t.corrected_at, u.display_name AS corrected_by
       FROM call_transcripts t LEFT JOIN users u ON u.id = t.corrected_by WHERE t.call_id = $1 ORDER BY t.seq`, [id])).rows : null;
    const approvals = (await c.query("SELECT id, action_type, status, summary FROM approvals WHERE call_id = $1 ORDER BY created_at", [id]).catch(() => ({ rows: [] }))).rows;
    if (canTranscript) await audit(c, actor, "call_transcript_viewed", "call", id);
    return {
      id: x.id, direction: x.direction, status: x.status, isSimulated: x.is_simulated, testCall: x.test_call, callerNumber: x.caller_number,
      startedAt: x.started_at, endedAt: x.ended_at, durationSeconds: x.duration_seconds, patientId: x.patient_id, patientName: x.patient_name, patientCode: x.patient_code,
      intent: x.intent, outcome: x.outcome, summary: x.summary, followUp: x.follow_up, purpose: x.purpose, language: x.language,
      handledByNepa: x.handled_by_nepa, handedToStaff: x.handed_to_staff, actions: x.actions_executed ?? [], configVersions: x.config_versions ?? {},
      recording: { status: x.recording_status, format: x.recording_format, hasFile: !!x.recording_ref },
      transcription: { status: x.transcription_status, error: x.transcription_error, attempts: x.transcription_attempts, provider: x.transcription_provider },
      transcript: transcript?.map((t) => ({ id: t.id, seq: t.seq, speaker: t.speaker, language: t.language, original: t.text_original, corrected: t.text_corrected, correctedBy: t.corrected_by, correctedAt: t.corrected_at, atMs: t.at_ms })) ?? null,
      approvals: approvals.map((a: Record<string, any>) => ({ id: a.id, action: a.action_type, status: a.status, summary: a.summary })),
      callbackOf: x.callback_of, provider: x.provider,
    };
  });
}

/** A human correction is stored next to the original, never over it. */
export async function correctTranscript(actor: SignedInUser, segmentId: string, text: string) {
  return act(actor, async (c) => {
    await requireCap(c, "view_call_transcripts", "You don't have permission to correct transcripts.");
    const t = text.trim();
    const r = await c.query("UPDATE call_transcripts SET text_corrected = $2, corrected_by = $3, corrected_at = now() WHERE id = $1 RETURNING call_id",
      [segmentId, t || null, actor.userId]);
    if (!r.rowCount) throw new UserError("Transcript line not found.");
    await audit(c, actor, "transcript_corrected", "call", r.rows[0].call_id, { segment: segmentId });
    return null;
  });
}

export async function retryTranscription(actor: SignedInUser, callId: string) {
  const ok = await act(actor, async (c) => {
    await requireCap(c, "view_call_transcripts");
    const x = (await c.query("SELECT clinic_id FROM calls WHERE id = $1", [callId])).rows[0];
    if (!x) throw new UserError("Call not found.");
    await audit(c, actor, "transcription_retried", "call", callId);
    return x.clinic_id as string;
  });
  if (!ok.ok) return ok;
  return { ok: true as const, value: await transcribeRecording(ok.value, callId) };
}

/** Staff call back a missed call through NEPA (queues an outgoing callback linked to the missed call). */
export async function callBack(actor: SignedInUser, missedCallId: string) {
  const call = await act(actor, async (c) => {
    await requireCap(c, "view_calls");
    const x = (await c.query("SELECT patient_id, status, is_simulated FROM calls WHERE id = $1", [missedCallId])).rows[0];
    if (!x) throw new UserError("Call not found.");
    if (!x.patient_id) throw new UserError("This number isn't linked to a patient yet. Add the patient first, then call back.");
    return x;
  });
  if (!call.ok) return call;
  const q = await queueOutbound(actor.clinicId!, { patientId: call.value.patient_id, purpose: "callback", callbackOf: missedCallId, simulated: call.value.is_simulated, agentKind: "receptionist", summary: "Call back a missed call" });
  return { ok: true as const, value: q };
}
