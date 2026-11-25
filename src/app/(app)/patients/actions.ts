"use server";

import { redirect } from "next/navigation";
import { checked, field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { importPatientsCsv, mergePatients, recordConsent, registerPatient, updateClinical, updatePatient, type PatientInput } from "@/lib/patients/service";
import { uploadDocument } from "@/lib/documents/service";
import { setPatientWhatsApp } from "@/lib/whatsapp/service";

function patientFields(f: FormData): PatientInput {
  return {
    name: field(f, "name"), phone: field(f, "phone"), email: field(f, "email"), dateOfBirth: field(f, "dateOfBirth"),
    ageYears: field(f, "ageYears"), gender: field(f, "gender"), address: field(f, "address"),
    assignedDoctorId: field(f, "assignedDoctorId"), firstProblem: field(f, "firstProblem"),
  };
}

export async function registerAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await registerPatient(user, patientFields(f), { confirmNew: checked(f, "confirmNew") });
  if (r.ok && "duplicates" in r.value) {
    return {
      error: "This may be a patient you already have. Open their record, or tick “This is a different person” and save again.",
      field: "confirmNew",
      links: r.value.duplicates.map((d) => ({ href: `/patients/${d.patientId}`, label: `${d.name} (${d.code})`, note: d.reason })),
    };
  }
  const next = field(f, "next") || field(f, "from");
  return finish(r, { redirect: (v) => ("patientId" in v ? (next === "book" ? `/appointments/new?patient=${v.patientId}` : `/patients/${v.patientId}?ok=registered`) : "/patients"), revalidate: ["/patients"] });
}

export async function editAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  return finish(await updatePatient(user, id, patientFields(f)), { redirect: `/patients/${id}?ok=saved`, revalidate: [`/patients/${id}`] });
}

export async function clinicalAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const r = await updateClinical(user, id, { medicalHistory: String(f.get("medicalHistory") ?? ""), allergies: String(f.get("allergies") ?? ""), notes: String(f.get("notes") ?? "") });
  return finish(r, { message: "Medical history saved.", revalidate: [`/patients/${id}`] });
}

export async function consentAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const r = await recordConsent(user, id, { status: field(f, "status") as "given", method: field(f, "method") as "verbal", language: field(f, "language") as "en", note: field(f, "note") });
  return finish(r, { redirect: `/patients/${id}?ok=consent#consent`, revalidate: [`/patients/${id}`] });
}

export async function uploadAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const file = f.get("file");
  const bytes = file instanceof File && file.size > 0 ? { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) } : null;
  const r = await uploadDocument(user, { patientId: id, docType: field(f, "docType") as "report", description: field(f, "description"), file: bytes });
  return finish(r, { redirect: `/patients/${id}?ok=uploaded#documents`, revalidate: [`/patients/${id}`] });
}

export async function mergeAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const keep = field(f, "keep");
  if (!checked(f, "sure")) return { error: "Tick the box to confirm these are the same person.", field: "sure" };
  const r = await mergePatients(user, keep, field(f, "merge"));
  return finish(r, { redirect: `/patients/${keep}?ok=merged`, revalidate: ["/patients"] });
}

export async function importAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const file = f.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file.", field: "file" };
  if (file.size > 5 * 1024 * 1024) return { error: "The file is too big (limit 5 MB).", field: "file" };
  const r = await importPatientsCsv(user, await file.text());
  if (!r.ok) return { error: r.error };
  const rep = r.value;
  const parts = [`${rep.created} patient${rep.created === 1 ? "" : "s"} added.`];
  if (rep.skippedDuplicates.length) parts.push(`${rep.skippedDuplicates.length} skipped because they look like existing patients (rows ${rep.skippedDuplicates.map((s) => s.row).join(", ")}).`);
  if (rep.errors.length) parts.push(`${rep.errors.length} rows had problems: ${rep.errors.slice(0, 5).map((e) => `row ${e.row}: ${e.error}`).join("; ")}${rep.errors.length > 5 ? "…" : ""}`);
  return { message: parts.join(" "), ok: Date.now() };
}

export async function goToPatient(f: FormData) {
  redirect(`/patients?q=${encodeURIComponent(field(f, "q"))}`);
}

export async function whatsappOptAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const r = await setPatientWhatsApp(user, id, { status: field(f, "status"), language: field(f, "language") });
  return finish(r, { message: "WhatsApp choice recorded.", revalidate: [`/patients/${id}`] });
}
