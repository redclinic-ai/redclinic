import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session-cookie";
import { clinicDetail } from "@/lib/admin/service";
import { listPlans, rupees } from "@/lib/billing/service";
import { Badge, Flash, fmtDate, fmtDateTime, PageHeader, Simulated } from "@/components/ui";
import { ActionForm, Submit } from "@/components/action-form";
import { Input, Select } from "@/components/form";
import { clinicAction, simulatePaymentAction } from "../../actions";

export const metadata = { title: "Clinic · RedClinic admin" };
const ROLE: Record<string, string> = { clinic_admin: "Clinic admin", doctor: "Doctor", receptionist: "Receptionist", clinic_manager: "Clinic manager" };

export default async function AdminClinic({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const { ok } = await searchParams;
  const [r, plans] = await Promise.all([clinicDetail(user, id), listPlans(user)]);
  if (!r.ok) notFound();
  const d = r.value;
  const e = d.entitlements;
  const hidden = <input type="hidden" name="clinicId" value={id} />;
  return (
    <>
      <Flash ok={ok} />
      <PageHeader title={d.clinic.name} back={{ href: "/admin", label: "Clinics" }}
        subtitle={`${d.clinic.type}${d.clinic.city ? ` · ${d.clinic.city}` : ""} · ${d.clinic.phone ?? ""} · joined ${fmtDate(d.clinic.createdAt)}${d.terms ? ` · accepted terms ${d.terms.terms_version}` : ""}`}
        actions={<Badge status={d.clinic.status} label={d.clinic.status === "suspended" ? "Paused" : "Active"} />} />
      <div className="alert alert-sim small">You are viewing this clinic's data as RedClinic. This visit is recorded in the clinic's audit log.</div>
      <div className="grid2">
        <section className="card">
          <h2 className="h2">Usage this period</h2>
          <dl className="stats">
            <div><dt>Voice minutes</dt><dd>{e.minutesUsed}<span className="muted small"> / {e.voiceMinutes}</span></dd></div>
            <div><dt>Real calls (all time)</dt><dd>{d.counts.calls}</dd></div>
            <div><dt>Appointments</dt><dd>{d.counts.appointments}</dd></div>
            <div><dt>Patients</dt><dd>{d.counts.patients}</dd></div>
          </dl>
          <p className="small muted">Plan {e.planName ?? "none"} · {e.status} · period {fmtDate(e.periodStart)} – {fmtDate(e.periodEnd)} · {e.outboundCalls ? "incoming and outgoing calls" : "incoming calls only"} · {e.staffAccounts} staff seats</p>
        </section>
        <section className="card">
          <h2 className="h2">Pause or resume (kill switch)</h2>
          {d.clinic.status === "suspended" ? (
            <ActionForm action={clinicAction}>{hidden}
              <p>Paused {fmtDateTime(d.clinic.suspendedAt)}: {d.clinic.suspendedReason}</p>
              <Submit name="op" value="resume">Resume clinic</Submit>
            </ActionForm>
          ) : (
            <ActionForm action={clinicAction}>{hidden}
              <p className="small">Pausing stops NEPA at once and signs staff out of clinic data until you resume. Nothing is deleted.</p>
              <Input label="Reason (shown in the audit log)" name="reason" />
              <Submit variant="danger" name="op" value="suspend" pending="Pausing…">Pause clinic</Submit>
            </ActionForm>
          )}
        </section>
      </div>
      <div className="grid2">
        <section className="card">
          <h2 className="h2">Features</h2>
          <ActionForm action={clinicAction}>{hidden}
            <ul className="mini-list">
              {d.features.map((f) => (
                <li key={f.key} className="hist-row"><span>{f.label}</span>
                  {f.enabled ? <Submit variant="ghost" name="op" value={`feature:${f.key}:off`} pending="…">Switch off</Submit> : <Submit name="op" value={`feature:${f.key}:on`} pending="…">Switch on</Submit>}</li>
              ))}
            </ul>
          </ActionForm>
        </section>
        <section className="card">
          <h2 className="h2">NEPA phone number</h2>
          <p className="small">Clinic number: {d.phone?.clinicNumber || "not given yet"} · handover mobile: {d.phone?.fallback || "not given yet"}</p>
          <ActionForm action={clinicAction}>{hidden}
            <Input label="NEPA number for this clinic (from the telephony provider)" name="receptionistNumber" defaultValue={d.phone?.receptionistNumber ?? ""} />
            <label className="check"><input type="checkbox" name="verified" defaultChecked={d.phone?.status === "verified"} /> <span>Forwarding tested with a real call</span></label>
            <Submit name="op" value="number">Save number</Submit>
          </ActionForm>
        </section>
      </div>
      <section className="card">
        <h2 className="h2">Plan and billing <Simulated /></h2>
        <ActionForm action={clinicAction} className="form-inline">{hidden}
          <Select label="Plan" name="plan" required defaultValue={e.planCode ?? "growth"} options={(plans.ok ? plans.value : []).map((p) => [p.code, `${p.name} (${rupees(p.priceMonthlyPaise)}/month${p.status !== "active" ? `, ${p.status}` : ""})`])} />
          <Select label="Billing" name="period" required defaultValue="monthly" options={[["monthly", "Monthly"], ["annual", "Annual (11 months for 12)"]]} />
          <label className="check"><input type="checkbox" name="waive" /> <span>Waive setup fee</span></label>
          <Input label="Why waived" name="waiverNote" required={false} placeholder="e.g. 3 references given and called" />
          <Submit name="op" value="plan" pending="…">Change plan and issue invoice</Submit>
        </ActionForm>
        {d.invoices.length > 0 && (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Invoice</th><th>Issued</th><th className="num">Total (incl. GST)</th><th>Status</th><th>Simulate</th></tr></thead>
            <tbody>{d.invoices.map((i) => (
              <tr key={i.number}><td>{i.number}</td><td>{fmtDate(i.issued_at)}</td><td className="num">{rupees(i.total_paise)}</td><td><Badge status={i.status === "paid" ? "active" : i.status === "failed" ? "failed" : "pending"} label={i.status} /></td>
                <td>{i.status !== "paid" && (
                  <ActionForm action={simulatePaymentAction} className="inline-form">{hidden}<input type="hidden" name="invoice" value={i.number} />
                    <Submit variant="ghost" name="type" value="payment.succeeded" pending="…">Paid</Submit>
                    <Submit variant="ghost" name="type" value="payment.failed" pending="…">Failed</Submit>
                  </ActionForm>)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="field-hint">No payment gateway is connected. These buttons send the same signed events a real gateway will send.</p>
      </section>
      <div className="grid2">
        <section className="card">
          <h2 className="h2">Staff</h2>
          <ul className="mini-list">{d.staff.map((s) => <li key={s.id}>{s.name} · {ROLE[s.role] ?? s.role} · <span className="muted small">{s.email}</span> {s.status !== "active" && <Badge status="deactivated" label="Off" />}</li>)}</ul>
        </section>
        <section className="card">
          <h2 className="h2">Recent calls</h2>
          {d.calls.length === 0 ? <p className="muted">No calls yet.</p> : (
            <ul className="mini-list">{d.calls.map((c) => (
              <li key={c.id}><Link href={`/calls/${c.id}`}>{fmtDateTime(c.startedAt)} · {c.direction}</Link> {c.simulated && <Simulated />} <Badge status={c.status} /><div className="muted small">{c.summary}</div></li>
            ))}</ul>
          )}
          <p className="small"><Link href={`/admin/audit?clinic=${id}`}>Audit log for this clinic</Link></p>
        </section>
      </div>
    </>
  );
}
