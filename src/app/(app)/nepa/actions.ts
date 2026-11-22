"use server";

import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { ACTIONS, discardDraft, publishDraft, rollbackTo, saveDraft, setAgentEnabled } from "@/lib/nepa/config";

const lines = (f: FormData, k: string) => field(f, k).split("\n").map((x) => x.trim()).filter(Boolean);
function permissionsFrom(f: FormData) {
  return Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, field(f, `perm_${a}`)]).filter(([, v]) => v));
}

export async function saveClinicNepaAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const data = {
    greeting: { en: field(f, "greeting_en"), hi: field(f, "greeting_hi"), kn: field(f, "greeting_kn") },
    tone: field(f, "tone"), personality: field(f, "personality"), preferredLanguage: field(f, "preferredLanguage"),
    languageSwitching: checked(f, "languageSwitching"), appointmentPolicy: field(f, "appointmentPolicy"), instructions: field(f, "instructions"),
    escalation: { fallbackNumber: field(f, "fallbackNumber"), keywords: lines(f, "keywords") },
    permissions: permissionsFrom(f),
  };
  const r = await saveDraft(user, null, data, field(f, "note"));
  if (!r.ok) return { error: r.error };
  if (f.get("publish")) return finish(await publishDraft(user, null), { redirect: "/nepa?ok=published", revalidate: ["/nepa"] });
  const clamped = r.value.clamped.length ? ` Some permissions were lowered to what RedClinic allows: ${r.value.clamped.map((c) => ACTIONS[c.action].label).join(", ")}.` : "";
  return { message: `Draft saved. It is not live until you publish.${clamped}`, ok: Date.now() };
}

export async function saveAgentAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "agentId");
  const data = {
    name: field(f, "name"), objective: field(f, "objective"), personality: field(f, "personality"),
    voice: { provider: "cartesia", voiceId: field(f, "voiceId") }, languages: f.getAll("languages").map(String),
    scripts: { greeting: field(f, "s_greeting"), closing: field(f, "s_closing"), transfer: field(f, "s_transfer"), afterHours: field(f, "s_afterHours") },
    knowledgeScope: field(f, "knowledgeScope"), operatingHours: field(f, "operatingHours"),
    permissions: permissionsFrom(f), escalation: { keywords: lines(f, "keywords"), maxTurnsBeforeHandoff: Number(field(f, "maxTurns") || 12) },
  };
  const r = await saveDraft(user, id, data, field(f, "note"));
  if (!r.ok) return { error: r.error };
  if (f.get("publish")) return finish(await publishDraft(user, id), { redirect: `/nepa/agents/${id}?ok=published`, revalidate: ["/nepa"] });
  const clamped = r.value.clamped.length ? ` Some permissions were lowered to the clinic's limits: ${r.value.clamped.map((c) => ACTIONS[c.action].label).join(", ")}.` : "";
  return { message: `Draft saved. It is not live until you publish.${clamped}`, ok: Date.now() };
}

export async function versionAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const agentId = field(f, "agentId") || null;
  const back = agentId ? `/nepa/agents/${agentId}` : "/nepa";
  const op = field(f, "op");
  if (op === "discard") return finish(await discardDraft(user, agentId), { redirect: `${back}?ok=saved`, revalidate: ["/nepa"] });
  if (op === "publish") return finish(await publishDraft(user, agentId), { redirect: `${back}?ok=published`, revalidate: ["/nepa"] });
  if (op.startsWith("rollback:")) return finish(await rollbackTo(user, agentId, Number(op.slice(9))), { redirect: `${back}?ok=restored`, revalidate: ["/nepa"] });
  if (op === "enable" || op === "disable") return finish(await setAgentEnabled(user, agentId!, op === "enable"), { redirect: `${back}?ok=saved`, revalidate: ["/nepa"] });
  return { error: "Unknown action." };
}

