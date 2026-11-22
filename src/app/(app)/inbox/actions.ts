"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { addAttention, assignAttention, reopenAttention, resolveAttention, snoozeAttention } from "@/lib/attention/service";

export async function itemAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const op = field(f, "op");
  const r = op === "resolve" ? await resolveAttention(user, id, field(f, "note"))
    : op === "reopen" ? await reopenAttention(user, id)
    : op === "assign_me" ? await assignAttention(user, id, user.userId)
    : op === "unassign" ? await assignAttention(user, id, null)
    : op.startsWith("snooze:") ? await snoozeAttention(user, id, op.slice(7))
    : { ok: false as const, error: "Unknown action." };
  const back = field(f, "back") || "/inbox";
  const sep = back.includes("?") ? "&" : "?";
  if (op === "resolve" || op === "reopen" || op.startsWith("snooze:")) {
    return finish(r, { redirect: `${back}${sep}ok=${op === "resolve" ? "resolved" : op === "reopen" ? "saved" : "snoozed"}`, revalidate: ["/inbox", "/home"] });
  }
  return finish(r, { message: "Saved.", revalidate: ["/inbox", "/home"] });
}

export async function addAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await addAttention(user, { kind: field(f, "kind"), reason: field(f, "reason"), urgency: field(f, "urgent") === "on" ? 1 : 2 });
  return finish(r, { message: "Added to the list.", revalidate: ["/inbox", "/home"] });
}
