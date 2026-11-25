"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { markHandled, staffReply } from "@/lib/whatsapp/service";

export async function replyAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "patientId");
  const r = await staffReply(user, id, field(f, "text"));
  return finish(r, { redirect: `/messages/${id}?ok=sent`, revalidate: [`/messages/${id}`, "/messages"] });
}

export async function handledAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "patientId");
  return finish(await markHandled(user, id), { redirect: `/messages/${id}?ok=resolved`, revalidate: ["/messages"] });
}
