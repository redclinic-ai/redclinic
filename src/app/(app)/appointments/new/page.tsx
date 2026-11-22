import { requirePageCap } from "@/lib/nav";
import Link from "next/link";
import { requireUser } from "@/lib/auth/session-cookie";
import { clinicToday } from "@/lib/appointments/service";
import { getPatient, listDoctors, searchPatients } from "@/lib/patients/service";
import { listServices } from "@/lib/clinic/service";
import { PageHeader } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { Icon } from "@/components/icons";
import { bookAction } from "../actions";

export const metadata = { title: "Book appointment · RedClinic" };

export default async function NewAppointmentPage({ searchParams }: { searchParams: Promise<{ patient?: string; q?: string; date?: string; walkin?: string }> }) {
  const user = await requireUser();
  await requirePageCap(user, "manage_appointments");
  const sp = await searchParams;
  const walkIn = sp.walkin === "1";
  const keep = (extra: string) => `/appointments/new?${new URLSearchParams({ ...(sp.date ? { date: sp.date } : {}), ...(walkIn ? { walkin: "1" } : {}) })}&${extra}`;
  const patient = sp.patient ? await getPatient(user, sp.patient) : null;
  const title = walkIn ? "Walk-in patient" : "Book appointment";

  if (!patient?.ok) {
    const results = sp.q ? await searchPatients(user, { q: sp.q, limit: 10 }) : null;
    return (
      <>
        <PageHeader title={title} subtitle="First, find the patient." back={{ href: "/appointments", label: "Appointments" }} />
        <form className="searchbar" role="search">
          {sp.date && <input type="hidden" name="date" value={sp.date} />}
          {walkIn && <input type="hidden" name="walkin" value="1" />}
          <Icon name="search" />
          <label className="sr-only" htmlFor="q">Search patients</label>
          <input id="q" name="q" defaultValue={sp.q} placeholder="Name, mobile number or patient ID" type="search" autoFocus autoComplete="off" />
          <button className="btn btn-primary" type="submit">Find</button>
        </form>
        {results?.ok && (
          <ul className="list">
            {results.value.patients.map((p) => (
              <li key={p.id}><Link className="list-item list-row link-row" href={keep(`patient=${p.id}`)}>
                <span><span className="strong">{p.name}</span> <span className="muted small">{p.code}</span></span>
                <span className="muted small">{p.phone}</span>
              </Link></li>
            ))}
            <li><Link className="list-item link-row" href={`/patients/new?next=book&name=${encodeURIComponent(sp.q ?? "")}`}><Icon name="plus" size={18} /> New patient{sp.q ? ` “${sp.q}”` : ""}</Link></li>
          </ul>
        )}
      </>
    );
  }

  const [doctors, services, today] = await Promise.all([listDoctors(user), listServices(user, true), clinicToday(user)]);
  const p = patient.value;
  const docs = doctors.ok ? doctors.value : [];
  return (
    <>
      <PageHeader title={title} subtitle={<>For <strong>{p.name}</strong> ({p.code}) · <Link href={keep(`q=`)}>change</Link></>} back={{ href: "/appointments", label: "Appointments" }} />
      {docs.length === 0 ? (
        <div className="alert alert-error">Add a doctor first in Settings → Staff.</div>
      ) : (
        <ActionForm action={bookAction} className="card form-narrow">
          <input type="hidden" name="patientId" value={p.id} />
          {walkIn && <input type="hidden" name="walkIn" value="1" />}
          <Select label="Doctor" name="doctorId" required defaultValue={p.assignedDoctorId ?? docs[0].id} options={docs.map((d) => [d.id, d.name])} />
          {services.ok && services.value.length > 0 && (
            <Select label="Treatment" name="serviceId" options={services.value.map((s) => [s.id, `${s.name} (${s.durationMinutes} min)`])} />
          )}
          {!walkIn && (
            <>
              <div className="row2">
                <Input label="Date" name="date" type="date" defaultValue={sp.date ?? (today.ok ? today.value : "")} min={today.ok ? today.value : undefined} />
                <Input label="Time" name="time" type="time" defaultValue="10:00" />
              </div>
              <Input label="Length in minutes" name="durationMinutes" type="number" inputMode="numeric" required={false} hint="Leave empty to use the treatment's usual length." />
            </>
          )}
          <Input label="Reason" name="reason" required={false} placeholder="e.g. tooth pain, follow-up" />
          <Submit pending="Booking…">{walkIn ? "Add to today's list" : "Book appointment"}</Submit>
        </ActionForm>
      )}
    </>
  );
}
