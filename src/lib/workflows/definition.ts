// Workflow definition (format 2). Plain data, edited by clinics through a simple form, run by the engine.
import { z } from "zod";
import { TEMPLATE_KEYS, TEMPLATES } from "../whatsapp/templates";

export const EVENTS = {
  appointment_scheduled: "When an appointment is booked",
  appointment_no_show: "When a patient doesn't come",
  appointment_completed: "After a visit is marked done",
  months_since_last_visit: "Some months after the last visit",
  weeks_since_last_visit: "Some weeks after the last visit",
  enquiry_without_booking: "When a caller enquires but doesn't book",
  lead_received: "When a lead-ad or new enquiry comes in",
} as const;
export const PURPOSES = {
  confirmation: "Confirm the appointment", recall: "Offer a check-up", follow_up: "Book the next visit",
  no_show_followup: "Rebook a missed appointment", checkin: "Ask how they feel after treatment", reminder: "Remind about the appointment",
} as const;
export const CONDITIONS = {
  always: "Always", not_confirmed: "Only if not confirmed yet", not_rebooked: "Only if not rebooked", no_upcoming: "Only if nothing is booked",
  was_confirmed: "Only if they had confirmed",
} as const;

const step = z.object({
  key: z.string().trim().min(1).max(40),
  afterMinutes: z.number().int().min(0).max(525_600).optional(),
  beforeAppointmentMinutes: z.number().int().min(10).max(20_160).optional(),
  action: z.enum(["call", "attention", "whatsapp"]),
  template: z.enum(TEMPLATE_KEYS).optional(),
  purpose: z.enum(Object.keys(PURPOSES) as [keyof typeof PURPOSES]).optional(),
  onlyIf: z.enum(Object.keys(CONDITIONS) as [keyof typeof CONDITIONS]).default("always"),
  script: z.string().max(500).optional(),
  reason: z.string().max(300).optional(),
}).refine((s) => (s.afterMinutes === undefined) !== (s.beforeAppointmentMinutes === undefined), "Each step needs one timing: after the trigger, or before the appointment.")
  .refine((s) => s.action !== "call" || !!s.purpose, "A call step needs a purpose.")
  .refine((s) => s.action !== "whatsapp" || !!s.template, "A WhatsApp step needs a message.");

export const definitionSchema = z.object({
  trigger: z.object({
    event: z.enum(Object.keys(EVENTS) as [keyof typeof EVENTS]),
    serviceMatch: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
    months: z.number().int().min(1).max(36).optional(),
    weeks: z.number().int().min(1).max(52).optional(),
  }),
  steps: z.array(step).min(1, "Add at least one step.").max(6, "Use at most 6 steps."),
}).superRefine((d, ctx) => {
  if (d.steps.some((s) => s.beforeAppointmentMinutes !== undefined) && d.trigger.event !== "appointment_scheduled") {
    ctx.addIssue({ code: "custom", message: "“Before the appointment” timing only works with “When an appointment is booked”." });
  }
  if (d.trigger.event === "months_since_last_visit" && !d.trigger.months) ctx.addIssue({ code: "custom", message: "Say how many months." });
  if (d.trigger.event === "weeks_since_last_visit" && !d.trigger.weeks) ctx.addIssue({ code: "custom", message: "Say how many weeks." });
  const calls = d.steps.filter((s) => s.action === "call").length;
  if (calls > 3) ctx.addIssue({ code: "custom", message: "A workflow can call a patient at most 3 times." });
  if (d.steps.filter((s) => s.action === "whatsapp").length > 3) ctx.addIssue({ code: "custom", message: "A workflow can message a patient at most 3 times." });
  if (d.steps.some((s) => s.onlyIf === "was_confirmed") && d.trigger.event !== "appointment_no_show") {
    ctx.addIssue({ code: "custom", message: "“Only if they had confirmed” works with “When a patient doesn't come”." });
  }
});
export type Definition = z.infer<typeof definitionSchema>;

/** Which NEPA agent makes each kind of call. */
export const AGENT_FOR: Record<string, string> = {
  confirmation: "reminder", reminder: "reminder", checkin: "feedback", recall: "lead_followup", follow_up: "lead_followup", no_show_followup: "lead_followup",
};

/** One line describing a step, for people. */
export function describeStep(s: Definition["steps"][number]): string {
  const when = s.beforeAppointmentMinutes !== undefined ? `${fmtMinutes(s.beforeAppointmentMinutes)} before the appointment`
    : s.afterMinutes === 0 ? "Straight away" : `${fmtMinutes(s.afterMinutes!)} later`;
  const what = s.action === "call" ? `NEPA calls to ${(PURPOSES[s.purpose!] ?? "").toLowerCase()}`
    : s.action === "whatsapp" ? `WhatsApp: ${(TEMPLATES[s.template!]?.label ?? "message").toLowerCase()}`
    : `Tell staff: ${(s.reason ?? "needs attention").replace(/[.\s]+$/, "")}`;
  return `${when}: ${what}${s.onlyIf !== "always" ? ` (${CONDITIONS[s.onlyIf].toLowerCase()})` : ""}.`;
}
export function fmtMinutes(m: number) {
  if (m % 1440 === 0) return `${m / 1440} day${m === 1440 ? "" : "s"}`;
  if (m % 60 === 0) return `${m / 60} hour${m === 60 ? "" : "s"}`;
  return m > 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} minutes`;
}
