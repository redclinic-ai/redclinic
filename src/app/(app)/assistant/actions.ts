"use server";

import { requireUser } from "@/lib/action-helpers";
import { ask, type AssistantAnswer } from "@/lib/assistant/service";

export interface AskState { q?: string; answer?: AssistantAnswer; error?: string }

/** Questions are posted, never put in the address bar: they can contain clinical notes. */
export async function askAction(_: AskState, f: FormData): Promise<AskState> {
  const user = await requireUser();
  const q = String(f.get("q") ?? "").trim();
  const patient = String(f.get("patient") ?? "") || undefined;
  if (!q) return { error: "Type a question." };
  const r = await ask(user, q, { patientId: patient });
  return r.ok ? { q, answer: r.value } : { q, error: r.error };
}
