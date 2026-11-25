"use server";

import { redirect } from "next/navigation";
import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { addRecordItem, confirmExtraction, dismissExtraction, readDocument, setRecordItemStatus, startVisit, type RecordKind } from "@/lib/records/service";

const pick = (f: FormData, keys: string[]) => Object.fromEntries(keys.map((k) => [k, field(f, k)]));

export async function addItemAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "patientId");
  const r = await addRecordItem(user, id, field(f, "kind") as RecordKind,
    pick(f, ["name", "since", "notes", "strength", "dose", "frequency", "duration", "route", "instructions", "substance", "reaction", "severity", "testName", "value", "unit", "range", "takenOn"]));
  return finish(r, { redirect: `/patients/${id}/record?ok=saved`, revalidate: [`/patients/${id}/record`] });
}

export async function itemStatusAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await setRecordItemStatus(user, field(f, "kind") as RecordKind, field(f, "id"), field(f, "status"));
  return finish(r, { redirect: (pid) => `/patients/${pid}/record?ok=saved` });
}

export async function startVisitAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await startVisit(user, { patientId: field(f, "patientId"), appointmentId: field(f, "appointmentId") || null });
  if (!r.ok) return { error: r.error };
  redirect(`/visits/${r.value}`);
}

export async function readDocumentAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const pid = field(f, "patientId"), did = field(f, "documentId");
  const r = await readDocument(user, did);
  return finish(r, { redirect: `/patients/${pid}/documents/${did}`, revalidate: [`/patients/${pid}/documents/${did}`] });
}

export async function confirmItemsAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const pid = field(f, "patientId"), did = field(f, "documentId");
  if (f.get("dismiss")) return finish(await dismissExtraction(user, did), { redirect: `/patients/${pid}/record?ok=saved` });
  const keys = f.getAll("take").map(String);
  const chosen = keys.map((key) => {
    const fields: Record<string, string> = {};
    for (const [k, v] of f.entries()) if (k.startsWith(`${key}.`) && typeof v === "string") fields[k.slice(key.length + 1)] = v.trim();
    return { key, fields };
  });
  const r = await confirmExtraction(user, did, chosen);
  return finish(r, { redirect: `/patients/${pid}/record?ok=saved`, revalidate: [`/patients/${pid}/record`] });
}
