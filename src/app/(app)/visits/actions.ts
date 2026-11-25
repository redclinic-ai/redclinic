"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { addAddendum, addVisitMedication, saveVisit, signVisit } from "@/lib/records/service";

const VITALS = ["bp_systolic", "bp_diastolic", "pulse", "temperature_c", "spo2", "weight_kg", "height_cm"];

export async function saveVisitAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const r = await saveVisit(user, id, {
    chiefComplaint: field(f, "chiefComplaint"), findings: field(f, "findings"), diagnosis: field(f, "diagnosis"), advice: field(f, "advice"), followUp: field(f, "followUp"),
    vitals: Object.fromEntries(VITALS.map((k) => [k, field(f, `v_${k}`)])),
  });
  return finish(r, { message: "Draft saved.", revalidate: [`/visits/${id}`] });
}

export async function visitMedAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const r = await addVisitMedication(user, id, Object.fromEntries(["name", "strength", "frequency", "duration", "instructions", "route"].map((k) => [k, field(f, k)])));
  return finish(r, { redirect: `/visits/${id}?ok=saved`, revalidate: [`/visits/${id}`] });
}

export async function signVisitAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  return finish(await signVisit(user, id), { redirect: `/visits/${id}?ok=saved`, revalidate: [`/visits/${id}`] });
}

export async function addendumAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  return finish(await addAddendum(user, id, field(f, "text")), { redirect: `/visits/${id}?ok=saved`, revalidate: [`/visits/${id}`] });
}
