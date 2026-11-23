"use server";

import { randomUUID } from "node:crypto";
import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { applyBillingEvent, assignPlan, savePlan, type BillingEventType } from "@/lib/billing/service";
import { assignNumber, setClinicStatus, setFeature } from "@/lib/admin/service";

export async function clinicAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "clinicId");
  const op = field(f, "op");
  const back = `/admin/clinics/${id}`;
  const r = op === "suspend" ? await setClinicStatus(user, id, "suspended", field(f, "reason"))
    : op === "resume" ? await setClinicStatus(user, id, "active", "")
    : op.startsWith("feature:") ? await setFeature(user, id, op.slice(8, op.lastIndexOf(":")), op.endsWith(":on"))
    : op === "plan" ? await assignPlan(user, id, { planCode: field(f, "plan"), period: field(f, "period") as "monthly", waiveSetup: checked(f, "waive"), waiverNote: field(f, "waiverNote") })
    : op === "number" ? await assignNumber(user, id, { receptionistNumber: field(f, "receptionistNumber"), verified: checked(f, "verified") })
    : { ok: false as const, error: "Unknown action." };
  return finish(r, { redirect: `${back}?ok=saved`, revalidate: ["/admin"] });
}

/** Simulated payment events (there is no live gateway). Same code path a verified gateway webhook uses. */
export async function simulatePaymentAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  if (!user.isSuperAdmin) return { error: "Only RedClinic can do this." };
  try {
    const r = await applyBillingEvent({ provider: "simulated", eventId: `admin-${randomUUID()}`, type: field(f, "type") as BillingEventType, invoiceNumber: field(f, "invoice"), simulated: true });
    return finish({ ok: true, value: r }, { redirect: `/admin/clinics/${field(f, "clinicId")}?ok=saved`, revalidate: ["/admin"] });
  } catch (e) { return { error: (e as Error).message }; }
}

export async function planAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await savePlan(user, field(f, "id"), {
    name: field(f, "name"), description: field(f, "description"), priceMonthly: field(f, "priceMonthly"), priceAnnual: field(f, "priceAnnual"),
    overagePerMinute: field(f, "overagePerMinute"), setupFee: field(f, "setupFee"), gstPercent: field(f, "gstPercent"), trialDays: field(f, "trialDays"),
    voiceMinutes: field(f, "voiceMinutes"), outboundCalls: checked(f, "outboundCalls"), staffAccounts: field(f, "staffAccounts"),
    status: field(f, "status") as "draft", notes: field(f, "notes"),
  });
  return finish(r, { message: "Plan saved.", revalidate: ["/admin/plans"] });
}
