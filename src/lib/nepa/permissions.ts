// NEPA permission engine. Decides, in code, what NEPA may do. Never left to the LLM.
// Order of strictness: prohibited < suggest < approval_required < automatic. The strictest layer wins.

export const MODES = ["prohibited", "suggest", "approval_required", "automatic"] as const;
export type Mode = (typeof MODES)[number];
const rank = (m: Mode) => MODES.indexOf(m);
export const strictest = (...ms: (Mode | undefined)[]): Mode => ms.filter(Boolean).reduce((a, b) => (rank(b!) < rank(a!) ? b : a)) as Mode;

export const ACTIONS = {
  search_patient:         { label: "Find a patient",                  default: "automatic",         max: "automatic" },
  read_clinic_info:       { label: "Answer from clinic details and FAQs", default: "automatic",     max: "automatic" },
  summarize:              { label: "Summarise records or calls",       default: "automatic",         max: "automatic" },
  draft_note:             { label: "Draft a note",                     default: "suggest",           max: "approval_required" },
  update_patient:         { label: "Change a patient's record",        default: "approval_required", max: "approval_required" },
  book_appointment:       { label: "Book an appointment",              default: "approval_required", max: "automatic" },
  reschedule_appointment: { label: "Move an appointment",              default: "approval_required", max: "automatic" },
  cancel_appointment:     { label: "Cancel an appointment",            default: "approval_required", max: "automatic" },
  outbound_call:          { label: "Make an outgoing call",            default: "approval_required", max: "automatic" },
  send_reminder:          { label: "Send a reminder or confirmation call", default: "approval_required", max: "automatic" },
  send_whatsapp:          { label: "Send a WhatsApp message",          default: "approval_required", max: "automatic" },
  delete_record:          { label: "Delete anything",                  default: "prohibited",        max: "approval_required" },
} as const satisfies Record<string, { label: string; default: Mode; max: Mode }>;
export type Action = keyof typeof ACTIONS;

export interface Decision { action: Action; mode: Mode; reason: string; layers: { global: Mode; clinic?: Mode; agent?: Mode; workflow?: Mode } }

export interface DecisionContext {
  clinic?: Partial<Record<Action, Mode>>;
  agent?: Partial<Record<Action, Mode>>;
  /** For outbound calls and reminders: the workflow that triggers it. Automatic only if that exact workflow is switched to automatic. */
  workflow?: { id: string; enabled: boolean; automaticEnabled: boolean } | null;
  /** Patient consent; withdrawn consent stops outbound contact. */
  consent?: "given" | "withdrawn" | "not_recorded";
}

export function decide(action: Action, ctx: DecisionContext = {}): Decision {
  const def = ACTIONS[action];
  if (!def) return { action, mode: "prohibited", reason: "Unknown action.", layers: { global: "prohibited" } };
  const globalMax = def.max as Mode;
  const clinic = ctx.clinic?.[action] ?? (def.default as Mode);
  const agent = ctx.agent?.[action];
  let mode = strictest(globalMax, clinic, agent);
  let reason = mode === "automatic" ? "Allowed." : mode === "prohibited" ? "Not allowed for NEPA." : mode === "suggest" ? "NEPA may only suggest this; staff do it." : "Needs staff approval.";
  let workflowMode: Mode | undefined;
  if (action === "outbound_call" || action === "send_reminder" || action === "send_whatsapp") {
    if (ctx.consent === "withdrawn") return { action, mode: "prohibited", reason: action === "send_whatsapp" ? "The patient withdrew consent for contact." : "The patient withdrew consent for calls.", layers: { global: globalMax, clinic, agent } };
    if (!ctx.workflow || !ctx.workflow.enabled) {
      workflowMode = "approval_required";
      reason = action === "send_whatsapp" ? "Messages need an approved workflow; without one, staff must approve each message." : "Outgoing calls need an approved workflow; without one, staff must approve each call.";
    } else {
      workflowMode = ctx.workflow.automaticEnabled ? "automatic" : "approval_required";
      if (!ctx.workflow.automaticEnabled) reason = `This workflow is not switched to automatic, so each ${action === "send_whatsapp" ? "message" : "call"} needs approval.`;
    }
    mode = strictest(mode, workflowMode);
  }
  return { action, mode, reason, layers: { global: globalMax, clinic, agent, workflow: workflowMode } };
}

/** Clamp a requested permission map to what is allowed above it; returns the clamped map and what changed. */
export function clampPermissions(requested: Partial<Record<string, string>>, above?: Partial<Record<Action, Mode>>) {
  const out: Partial<Record<Action, Mode>> = {};
  const clamped: { action: Action; asked: Mode; got: Mode }[] = [];
  for (const [k, v] of Object.entries(requested)) {
    if (!(k in ACTIONS) || !MODES.includes(v as Mode)) continue;
    const a = k as Action;
    const limit = strictest(ACTIONS[a].max as Mode, above?.[a] ?? (ACTIONS[a].max as Mode));
    const got = strictest(v as Mode, limit);
    out[a] = got;
    if (got !== v) clamped.push({ action: a, asked: v as Mode, got });
  }
  return { permissions: out, clamped };
}
