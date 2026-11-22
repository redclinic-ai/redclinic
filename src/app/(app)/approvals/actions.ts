"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { decideApproval } from "@/lib/nepa/approvals";

export async function decideAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const decision = field(f, "decision") === "reject" ? "reject" : "approve";
  const r = await decideApproval(user, field(f, "id"), decision, { note: field(f, "note"), date: field(f, "date"), time: field(f, "time") });
  if (r.ok && r.value.status === "failed") return { error: `Approved, but it could not be done: ${r.value.error} It has been added to Needs attention.` };
  return finish(r, { redirect: `/approvals?ok=${decision === "reject" ? "rejected" : "approved"}`, revalidate: ["/approvals", "/inbox", "/home", "/appointments"] });
}
