"use server";

import { field, finish, requireUser, safePath } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { applyMasterUpdate, createWorkflow, keepMyVersion, restoreWorkflowVersion, saveWorkflow, setWorkflowSwitches } from "@/lib/workflows/service";

const UNIT: Record<string, number> = { minutes: 1, hours: 60, days: 1440, weeks: 10080 };

/** Turns the step rows of the editor form into a definition. */
function definitionFrom(f: FormData) {
  const steps = [];
  for (let i = 0; i < 6; i++) {
    const action = field(f, `s${i}_action`);
    if (!action || action === "none") continue;
    const amount = Number(field(f, `s${i}_amount`) || 0) * (UNIT[field(f, `s${i}_unit`)] ?? 1);
    const when = field(f, `s${i}_when`);
    steps.push({
      key: field(f, `s${i}_key`) || `step${i + 1}`, action,
      ...(when === "before" ? { beforeAppointmentMinutes: amount } : { afterMinutes: amount }),
      ...(action === "call" ? { purpose: field(f, `s${i}_purpose`) }
        : action === "whatsapp" ? { template: field(f, `s${i}_template`) }
        : { reason: field(f, `s${i}_reason`) || "Needs staff attention." }),
      onlyIf: field(f, `s${i}_onlyIf`) || "always",
    });
  }
  const event = field(f, "event");
  const services = field(f, "serviceMatch").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    trigger: { event, ...(services.length ? { serviceMatch: services } : {}),
      ...(event === "months_since_last_visit" ? { months: Number(field(f, "months")) } : {}),
      ...(event === "weeks_since_last_visit" ? { weeks: Number(field(f, "weeks")) } : {}) },
    steps,
  };
}

export async function saveWorkflowAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  if (!id) return finish(await createWorkflow(user, { name: field(f, "name"), definition: definitionFrom(f) }), { redirect: (v) => `/workflows/${v}?ok=saved`, revalidate: ["/workflows"] });
  return finish(await saveWorkflow(user, id, { name: field(f, "name"), definition: definitionFrom(f), note: field(f, "note") }), { redirect: `/workflows/${id}?ok=saved`, revalidate: ["/workflows"] });
}

export async function switchAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const op = field(f, "op");
  const back = safePath(field(f, "back") || "/workflows", "/workflows");
  const r = op === "on" ? await setWorkflowSwitches(user, id, { enabled: true })
    : op === "off" ? await setWorkflowSwitches(user, id, { enabled: false })
    : op === "auto" ? await setWorkflowSwitches(user, id, { automatic: true })
    : op === "manual" ? await setWorkflowSwitches(user, id, { automatic: false })
    : op === "update" ? await applyMasterUpdate(user, id)
    : op === "keep" ? await keepMyVersion(user, id)
    : op.startsWith("restore:") ? await restoreWorkflowVersion(user, id, Number(op.slice(8)))
    : { ok: false as const, error: "Unknown action." };
  return finish(r, { redirect: `${back}${back.includes("?") ? "&" : "?"}ok=saved`, revalidate: ["/workflows"] });
}
