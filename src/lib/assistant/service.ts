// NEPA in-app assistant for staff. Fixed backend tools only, every answer linked to the records it came from,
// clear about what is not recorded, never diagnoses or recommends treatment. Each question is logged with the
// policy/config versions in force.
import type { PoolClient } from "pg";
import type { SignedInUser } from "../auth/service";
import { act, can, UserError } from "../authz";
import { resolve } from "../nepa/resolver";
import { decide } from "../nepa/permissions";
import { queueOutbound } from "../calls/service";
import { randomUUID } from "node:crypto";

export interface Source { type: "patient" | "appointment" | "document" | "call" | "note" | "consent"; id: string; label: string; href: string }
export interface AssistantAnswer { answer: string; lines: { text: string; source?: Source; unavailable?: boolean }[]; sources: Source[]; tools: string[]; suggestions?: string[] }

const fmt = (d: Date | string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(d));
const MEDICAL_ADVICE = /\b(diagnos\w*|what (medicine|drug|antibiotic)|prescri\w*|dose|dosage|should (i|we|he|she) (give|take|prescribe|start)|treatment plan|recommend (a )?treatment)\b/i;

async function findPatient(c: PoolClient, q: string) {
  const code = q.match(/\bRC-\d+\b/i)?.[0];
  if (code) {
    const r = await c.query("SELECT coalesce(p.merged_into, p.id) AS id FROM patients p WHERE upper(p.patient_code) = upper($1)", [code]);
    return r.rows.length ? { ids: [r.rows[0].id as string] } : { ids: [] };
  }
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 7) {
    const r = await c.query("SELECT id FROM patients WHERE merged_into IS NULL AND rc_phone_digits(phone) LIKE '%' || $1 || '%' LIMIT 5", [digits.slice(-10)]);
    return { ids: r.rows.map((x) => x.id as string) };
  }
  const name = q.replace(/\b(summary|summarise|summarize|history|of|for|about|tell|me|show|patient|documents?|appointments?|calls?|notes?|draft|the|please|what|is|was|last|visit|follow[- ]?up|call|prepare)\b/gi, " ").replace(/[^\p{L}\s.]/gu, " ").replace(/\s+/g, " ").trim();
  if (name.length < 3) return { ids: [] };
  const r = await c.query(
    "SELECT id FROM patients WHERE merged_into IS NULL AND (name ILIKE '%' || $1 || '%' OR similarity(name, $1) > 0.45) ORDER BY similarity(name, $1) DESC LIMIT 5", [name]);
  return { ids: r.rows.map((x) => x.id as string) };
}

async function patientSummary(c: PoolClient, id: string): Promise<AssistantAnswer> {
  const p = (await c.query("SELECT * FROM patients WHERE id = $1", [id])).rows[0];
  const src: Source = { type: "patient", id, label: `${p.name} (${p.patient_code})`, href: `/patients/${id}` };
  const lines: AssistantAnswer["lines"] = [{ text: `${p.name}, ${p.patient_code}${p.age_years != null ? `, ${p.age_years} yrs` : ""}${p.gender ? `, ${p.gender}` : ""}. Registered ${fmt(p.registered_at)}.`, source: src }];
  const sources: Source[] = [src];
  if (p.first_problem) lines.push({ text: `First came for: ${p.first_problem}`, source: src });
  if (await can(c, "view_patient_history")) {
    const cl = (await c.query("SELECT * FROM patient_clinical WHERE patient_id = $1", [id])).rows[0];
    const note: Source = { type: "note", id, label: "Medical history", href: `/patients/${id}` };
    lines.push(cl?.allergies ? { text: `Allergies: ${cl.allergies}`, source: note } : { text: "Allergies: not recorded.", unavailable: true });
    lines.push(cl?.medical_history ? { text: `History: ${cl.medical_history}`, source: note } : { text: "Medical history: not recorded.", unavailable: true });
    if (cl?.notes) lines.push({ text: `Notes: ${cl.notes.slice(0, 600)}${cl.notes.length > 600 ? "…" : ""}`, source: note });
    if (cl) sources.push(note);
  } else {
    lines.push({ text: "Medical history: you don't have permission to see it.", unavailable: true });
  }
  const appts = (await c.query(
    `SELECT a.id, a.starts_at, a.status, a.reason, s.name AS service, d.display_name AS doctor FROM appointments a
     LEFT JOIN clinic_services s ON s.id = a.service_id LEFT JOIN users d ON d.id = a.doctor_id
     WHERE a.patient_id = $1 AND a.status <> 'cancelled' ORDER BY a.starts_at DESC LIMIT 5`, [id])).rows;
  if (!appts.length) lines.push({ text: "No appointments recorded.", unavailable: true });
  for (const a of appts) {
    const s: Source = { type: "appointment", id: a.id, label: `Appointment ${fmt(a.starts_at)}`, href: `/appointments/${a.id}` };
    lines.push({ text: `${fmt(a.starts_at)}: ${a.status.replace("_", "-")}${a.service ? ` · ${a.service}` : ""}${a.reason ? ` · ${a.reason}` : ""}${a.doctor ? ` · ${a.doctor}` : ""}`, source: s });
    sources.push(s);
  }
  if (await can(c, "view_documents")) {
    const docs = (await c.query("SELECT id, doc_type, original_filename, uploaded_at, description FROM documents WHERE patient_id = $1 ORDER BY uploaded_at DESC LIMIT 5", [id])).rows;
    for (const d of docs) {
      const s: Source = { type: "document", id: d.id, label: d.original_filename ?? d.doc_type, href: d.original_filename ? `/api/documents/${d.id}/open` : `/patients/${id}#documents` };
      lines.push({ text: `${d.doc_type} ${fmt(d.uploaded_at)}${d.description ? `: ${d.description.slice(0, 160)}` : ""}`, source: s });
      sources.push(s);
    }
  }
  if (await can(c, "view_calls")) {
    const calls = (await c.query("SELECT id, started_at, summary FROM calls WHERE patient_id = $1 AND NOT is_simulated AND summary IS NOT NULL ORDER BY started_at DESC LIMIT 3", [id])).rows;
    for (const x of calls) {
      const s: Source = { type: "call", id: x.id, label: `Call ${fmt(x.started_at)}`, href: `/calls/${x.id}` };
      lines.push({ text: `Call ${fmt(x.started_at)}: ${x.summary}`, source: s });
      sources.push(s);
    }
  }
  lines.push({ text: `Consent: ${p.consent_status.replace("_", " ")}.`, source: src });
  return { answer: `Here is what is recorded for ${p.name}.`, lines, sources, tools: ["patient_summary"] };
}

async function missedAppointments(c: PoolClient, days: number): Promise<AssistantAnswer> {
  const r = await c.query(
    `SELECT a.id, a.starts_at, p.id AS pid, p.name, p.patient_code,
            EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.created_at > a.starts_at AND b.status <> 'cancelled') AS rebooked
     FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status = 'no_show' AND a.starts_at > now() - make_interval(days => $1) ORDER BY a.starts_at DESC LIMIT 50`, [days]);
  const lines = r.rows.map((x) => ({ text: `${x.name} (${x.patient_code}) missed ${fmt(x.starts_at)}${x.rebooked ? " · has booked again" : " · not rebooked"}`, source: { type: "appointment" as const, id: x.id, label: x.name, href: `/appointments/${x.id}` } }));
  return { answer: r.rowCount ? `${r.rowCount} missed appointment${r.rowCount === 1 ? "" : "s"} in the last ${days} days.` : `No missed appointments in the last ${days} days.`, lines, sources: lines.map((l) => l.source), tools: ["missed_appointments"] };
}

async function recentCalls(c: PoolClient): Promise<AssistantAnswer> {
  if (!(await can(c, "view_calls"))) return { answer: "You don't have permission to see calls.", lines: [], sources: [], tools: [] };
  const r = await c.query(
    `SELECT c.id, c.started_at, c.summary, c.status, p.name FROM calls c LEFT JOIN patients p ON p.id = c.patient_id
     WHERE NOT c.is_simulated AND c.started_at > now() - interval '24 hours' ORDER BY c.started_at DESC LIMIT 30`);
  const lines = r.rows.map((x) => ({ text: `${new Date(x.started_at).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })} · ${x.name ?? "Unknown caller"} · ${x.summary ?? x.status}`, source: { type: "call" as const, id: x.id, label: "Call", href: `/calls/${x.id}` } }));
  return { answer: r.rowCount ? `${r.rowCount} call${r.rowCount === 1 ? "" : "s"} in the last 24 hours.` : "No calls in the last 24 hours.", lines, sources: lines.map((l) => l.source), tools: ["recent_calls"] };
}

/** Answers a staff question. `confirm` carries a patient id when the person picked one from a list of matches. */
export async function ask(actor: SignedInUser, question: string, opts: { patientId?: string } = {}) {
  return act(actor, async (c): Promise<AssistantAnswer> => {
    const q = question.trim().slice(0, 1000);
    if (q.length < 2) throw new UserError("Type a question.");
    if (!(await can(c, "view_patients"))) throw new UserError("You don't have access to the assistant.");
    if (!(await c.query("SELECT rc_feature_enabled('assistant') AS on")).rows[0].on) throw new UserError("The assistant is switched off for your clinic. Please contact RedClinic.");
    const r = await resolve(c, null);
    let res: AssistantAnswer;

    if (MEDICAL_ADVICE.test(q)) {
      res = { answer: "I can't diagnose, prescribe or recommend treatment. I can show what is recorded for a patient so the doctor can decide.", lines: [], sources: [], tools: [] };
    } else if (/\b(missed|no[- ]?shows?)\b/i.test(q) && !/RC-\d+/i.test(q)) {
      const days = /\btoday\b/i.test(q) ? 1 : /\bmonth|30\b/i.test(q) ? 30 : 7;
      res = await missedAppointments(c, days);
    } else if (/\bcalls?\b/i.test(q) && /\b(today|recent|latest|last 24)\b/i.test(q) && !/RC-\d+/i.test(q)) {
      res = await recentCalls(c);
    } else {
      const draft = q.match(/^draft (?:a )?note for (.+?):\s*([\s\S]+)$/i);
      const follow = /\b(follow[- ]?up|call back|recall)\b/i.test(q);
      const found = opts.patientId ? { ids: [opts.patientId] } : await findPatient(c, draft ? draft[1] : q);
      if (found.ids.length === 0) {
        res = { answer: "I couldn't find that patient. Try their patient ID (like RC-10021), mobile number or full name.", lines: [], sources: [], tools: ["find_patient"],
          suggestions: ["Missed appointments this week", "Calls today"] };
      } else if (found.ids.length > 1) {
        const pts = (await c.query("SELECT id, name, patient_code, phone FROM patients WHERE id = ANY($1)", [found.ids])).rows;
        res = { answer: "More than one patient matches. Which one?", lines: pts.map((p) => ({ text: `${p.name} (${p.patient_code})${p.phone ? ` · ${p.phone}` : ""}`, source: { type: "patient" as const, id: p.id, label: p.name, href: `/patients/${p.id}` } })), sources: [], tools: ["find_patient"] };
      } else if (draft) {
        const d = decide("draft_note", { clinic: r.clinicConfig.permissions });
        if (d.mode === "prohibited") res = { answer: "Drafting notes is switched off for NEPA in this clinic.", lines: [], sources: [], tools: [] };
        else {
          const id = randomUUID();
          await c.query(`INSERT INTO approvals (id, clinic_id, requested_by, action_type, details, mode, status, patient_id, summary)
                         VALUES ($1, rc_clinic_id(), $2, 'draft_note', $3, $4, 'pending', $5, $6)`,
            [id, `assistant:${actor.userId}`, { patientId: found.ids[0], note: `${draft[2].trim()}\n— drafted with NEPA for ${actor.displayName}` }, d.mode === "automatic" ? "approval_required" : d.mode, found.ids[0], `Add note: ${draft[2].trim().slice(0, 80)}`]);
          res = { answer: "I've drafted the note. It is added to the record only after someone approves it in Approvals.", lines: [{ text: draft[2].trim() }], sources: [{ type: "patient", id: found.ids[0], label: "Patient", href: `/patients/${found.ids[0]}` }], tools: ["draft_note"] };
        }
      } else if (follow) {
        const out = await queueOutbound(actor.clinicId!, { patientId: found.ids[0], purpose: "follow_up", agentKind: "lead_followup", summary: `Follow-up call requested by ${actor.displayName}` });
        res = { answer: out.mode === "prohibited" ? `I can't call this patient: ${out.reason}` : out.mode === "approval_required" ? "I've prepared a follow-up call. It will be made after approval." : out.mode === "suggest" ? "NEPA may only suggest calls here. Please call the patient yourself." : "The follow-up call is queued.",
          lines: [], sources: [{ type: "patient", id: found.ids[0], label: "Patient", href: `/patients/${found.ids[0]}` }], tools: ["prepare_follow_up"] };
      } else {
        res = await patientSummary(c, found.ids[0]);
      }
    }
    await c.query(
      "INSERT INTO assistant_interactions (clinic_id, user_id, question, answer, sources, tools_used, config_versions, provider) VALUES (rc_clinic_id(),$1,$2,$3,$4,$5,$6,'rule-based')",
      [actor.userId, q, res.answer, JSON.stringify(res.sources), JSON.stringify(res.tools), r.versions]);
    return res;
  });
}
