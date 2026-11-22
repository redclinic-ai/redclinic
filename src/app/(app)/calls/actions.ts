"use server";

import { redirect } from "next/navigation";
import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { callBack, callerSays, correctTranscript, endCall, retryTranscription, startCall } from "@/lib/calls/service";
import { can } from "@/lib/authz";
import { withContext } from "@/lib/db";
import { contextOf } from "@/lib/auth/service";

async function requireTester() {
  const user = await requireUser();
  const allowed = await withContext(contextOf(user), async (c) => (await can(c, "edit_workflow")) || (await can(c, "view_calls")));
  if (!allowed || !user.clinicId) redirect("/home?denied=1");
  return user;
}

export async function startTestCallAction(f: FormData) {
  const user = await requireTester();
  const r = await startCall(user.clinicId!, { direction: "inbound", callerNumber: field(f, "phone") || null, simulated: true, testCall: true, lang: (field(f, "lang") || undefined) as "en" | undefined });
  redirect(`/calls/test?call=${r.callId}`);
}

export async function sayAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireTester();
  const text = field(f, "text");
  if (!text) return { error: "Type what the caller says.", field: "text" };
  try {
    const r = await callerSays(user.clinicId!, field(f, "callId"), text);
    return finish({ ok: true, value: r }, { message: "", revalidate: ["/calls/test"] });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function endTestCallAction(f: FormData) {
  const user = await requireTester();
  const id = field(f, "callId");
  await endCall(user.clinicId!, id, "caller_hung_up");
  redirect(`/calls/${id}?test=1`);
}

export async function correctAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  return finish(await correctTranscript(user, field(f, "segmentId"), field(f, "text")), { message: "Correction saved. The original is kept.", revalidate: [`/calls/${field(f, "callId")}`] });
}

export async function retryAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await retryTranscription(user, field(f, "callId"));
  if (!r.ok) return { error: r.error };
  return finish({ ok: true, value: null }, { message: r.value === "completed" ? "Transcribed." : r.value === "failed" ? "Transcription failed again. It is recorded; try later." : "No recording to transcribe.", revalidate: [`/calls/${field(f, "callId")}`] });
}

export async function callBackAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await callBack(user, field(f, "callId"));
  if (!r.ok) return { error: r.error };
  const m = r.value.mode === "approval_required" ? "Callback prepared. It goes out after approval." : r.value.mode === "automatic" ? "Callback queued." : `NEPA won't call: ${r.value.reason}`;
  return { message: m, ok: Date.now() };
}
