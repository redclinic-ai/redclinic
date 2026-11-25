"use server";

import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { addManualLead, setLeadStatus } from "@/lib/leads/service";

export async function addLeadAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await addManualLead(user, { name: field(f, "name"), phone: field(f, "phone"), problem: field(f, "problem"), whatsappOptIn: checked(f, "whatsappOptIn") });
  return finish(r, { redirect: "/leads?ok=saved", revalidate: ["/leads"] });
}

export async function leadStatusAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await setLeadStatus(user, field(f, "id"), field(f, "status") as "contacted");
  return finish(r, { redirect: "/leads?ok=saved", revalidate: ["/leads"] });
}
