import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { capabilitiesOf } from "@/lib/nav";
import { getAppointment } from "@/lib/appointments/service";
import { listDoctors } from "@/lib/patients/service";
import { Badge, Flash, fmtDay, fmtLocalTime, PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { moveAction, onlineAction, statusAction } from "../actions";
import { onlineDetails } from "@/lib/telehealth/service";
import { startVisitAction } from "../../patients/records-actions";

export const metadata = { title: "Appointment · RedClinic" };

function StatusButton({ id, status, label, variant = "ghost" }: { id: string; status: string; label: string; variant?: "primary" | "ghost" | "danger" }) {
  return (
    <ActionForm action={statusAction} className="inline">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="status" value={status} />
      <Submit variant={variant} pending="…">{label}</Submit>
    </ActionForm>
  );
}

export default async function AppointmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { ok } = await searchParams;
  const caps = await capabilitiesOf(user);
  const r = await getAppointment(user, id);
  if (!r.ok) notFound();
  const a = r.value;
  const upcoming = a.status === "scheduled" || a.status === "confirmed";
  const started = a.startsAt.getTime() <= Date.now() + 60 * 60_000;
  const doctors = upcoming ? await listDoctors(user) : null;
  const online = await onlineDetails(user, a.id);
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={`${fmtLocalTime(a.localTime)}, ${fmtDay(a.localDate)}`} back={{ href: `/appointments?date=${a.localDate}`, label: "Appointments" }}
        subtitle={<><Link href={`/patients/${a.patientId}`}>{a.patientName}</Link> ({a.patientCode}){a.patientPhone ? ` · ${a.patientPhone}` : ""}</>}
        actions={<Badge status={a.status} />} />
      <div className="card">
        <dl className="facts">
          <dt>Doctor</dt><dd>{a.doctorName ?? "—"}</dd>
          <dt>Treatment</dt><dd>{a.serviceName ?? "—"}</dd>
          <dt>Length</dt><dd>{a.durationMinutes} minutes</dd>
          <dt>Reason</dt><dd>{a.reason ?? "—"}</dd>
          <dt>Booked</dt><dd>{a.bookedVia === "walk_in" ? "Walk-in" : a.bookedVia === "nepa" ? "By the AI receptionist" : a.bookedVia === "import" ? "Imported" : "By staff"}</dd>
          {a.cancelReason && <><dt>Cancelled</dt><dd>{a.cancelReason}</dd></>}
        </dl>
        {caps.has("manage_appointments") && (
          <div className="form-actions">
            {a.status === "scheduled" && <StatusButton id={a.id} status="confirmed" label="Patient confirmed" variant="primary" />}
            {upcoming && started && <StatusButton id={a.id} status="completed" label="Mark as done" variant="primary" />}
            {upcoming && started && <StatusButton id={a.id} status="no_show" label="Didn't come" />}
            {a.status === "no_show" && <StatusButton id={a.id} status="completed" label="Patient came after all" />}
            {a.status === "confirmed" && <StatusButton id={a.id} status="scheduled" label="Undo confirmed" />}
          </div>
        )}
      </div>
      {(caps.has("write_clinical") || (online.ok && (online.value.available || online.value.online))) && (
        <section className="card">
          <h2 className="h2">{online.ok && online.value.online ? "Online consultation" : "Consultation"}</h2>
          {online.ok && online.value.url && (
            <p><a className="btn btn-primary" href={online.value.url} target="_blank" rel="noopener">Join the video call</a>
              <span className="muted small"> Private room for this appointment. The patient joins from the link on their phone.</span></p>
          )}
          {online.ok && online.value.online && online.value.publicService && <p className="muted small">Uses the free public Jitsi service. For real patients, RedClinic should set up its own video server (Settings → Online consultations).</p>}
          <div className="form-actions">
            {caps.has("manage_appointments") && upcoming && online.ok && online.value.available && !online.value.online && (
              <ActionForm action={onlineAction}><input type="hidden" name="id" value={a.id} /><Submit variant="ghost" name="op" value="online">Make this an online consultation</Submit></ActionForm>)}
            {caps.has("manage_appointments") && upcoming && online.ok && online.value.online && (<>
              <ActionForm action={onlineAction}><input type="hidden" name="id" value={a.id} /><Submit variant="ghost" name="op" value="send">Send the link on WhatsApp</Submit></ActionForm>
              <ActionForm action={onlineAction}><input type="hidden" name="id" value={a.id} /><Submit variant="ghost" name="op" value="in_clinic">Change to in-clinic</Submit></ActionForm></>)}
            {caps.has("write_clinical") && a.status !== "cancelled" && (
              <ActionForm action={startVisitAction}><input type="hidden" name="patientId" value={a.patientId} /><input type="hidden" name="appointmentId" value={a.id} />
                <Submit variant="ghost">Visit note</Submit></ActionForm>)}
          </div>
        </section>
      )}
      {caps.has("manage_appointments") && upcoming && (
        <div className="grid2">
          <ActionForm action={moveAction} className="card">
            <h2 className="h2">Move to another time</h2>
            <input type="hidden" name="id" value={a.id} />
            <div className="row2">
              <Input label="Date" name="date" type="date" defaultValue={a.localDate} />
              <Input label="Time" name="time" type="time" defaultValue={a.localTime} />
            </div>
            {doctors?.ok && <Select label="Doctor" name="doctorId" required defaultValue={a.doctorId ?? ""} options={doctors.value.map((d) => [d.id, d.name])} />}
            <Submit pending="Moving…">Move appointment</Submit>
          </ActionForm>
          <ActionForm action={statusAction} className="card">
            <h2 className="h2">Cancel</h2>
            <input type="hidden" name="id" value={a.id} /><input type="hidden" name="status" value="cancelled" />
            <Input label="Reason" name="cancelReason" required={false} placeholder="e.g. patient travelling" />
            <Submit variant="danger" pending="Cancelling…">Cancel appointment</Submit>
          </ActionForm>
        </div>
      )}
    </>
  );
}
