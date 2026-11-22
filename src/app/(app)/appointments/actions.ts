"use server";

import { field, finish, requireUser } from "@/lib/action-helpers";
import type { ActionState } from "@/components/action-form";
import { bookAppointment, bookWalkIn, rescheduleAppointment, setAppointmentStatus, type AppointmentStatus } from "@/lib/appointments/service";

export async function bookAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const input = { patientId: field(f, "patientId"), doctorId: field(f, "doctorId"), serviceId: field(f, "serviceId"), reason: field(f, "reason") };
  const r = field(f, "walkIn")
    ? await bookWalkIn(user, input)
    : await bookAppointment(user, { ...input, date: field(f, "date"), time: field(f, "time"), durationMinutes: field(f, "durationMinutes"), type: (field(f, "type") || "in_clinic") as "in_clinic" });
  return finish(r, { redirect: (id) => `/appointments/${id}?ok=booked`, revalidate: ["/appointments", "/home"] });
}

export async function statusAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const id = field(f, "id");
  const status = field(f, "status") as AppointmentStatus;
  const r = await setAppointmentStatus(user, id, status, field(f, "cancelReason"));
  return finish(r, { redirect: `/appointments/${id}?ok=${status}`, revalidate: ["/appointments", "/home"] });
}

export async function moveAction(_: ActionState, f: FormData): Promise<ActionState> {
  const user = await requireUser();
  const r = await rescheduleAppointment(user, field(f, "id"), { date: field(f, "date"), time: field(f, "time"), doctorId: field(f, "doctorId") || undefined });
  return finish(r, { redirect: (id) => `/appointments/${id}?ok=moved`, revalidate: ["/appointments", "/home"] });
}
