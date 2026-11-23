import { requireUser } from "@/lib/auth/session-cookie";
import { requirePageCap } from "@/lib/nav";
import { clinicBilling, rupees } from "@/lib/billing/service";
import { Badge, Empty, fmtDate, PageHeader, Simulated } from "@/components/ui";

export const metadata = { title: "Plan & usage · RedClinic" };
const STATUS: Record<string, string> = { trialing: "Free trial", active: "Active", grace: "Payment due", past_due: "Payment due", expired: "Ended", cancelled: "Cancelled", none: "No plan" };

export default async function BillingPage() {
  const user = await requireUser();
  await requirePageCap(user, "manage_billing");
  const r = await clinicBilling(user);
  if (!r.ok) return <p>{r.error}</p>;
  const { entitlements: e, subscription: s, plan, invoices, staff } = r.value;
  const pct = e.voiceMinutes ? Math.min(100, Math.round((e.minutesUsed * 100) / e.voiceMinutes)) : 0;
  return (
    <>
      <PageHeader title="Plan & usage" subtitle="Prices are before 18% GST. To change plan or pay, contact RedClinic on 9954674179 or hello@redclinic.ai."
        actions={<Badge status={e.serviceActive ? (s?.status === "active" ? "active" : "pending") : "failed"} label={STATUS[e.status] ?? e.status} />} />
      {s?.status === "grace" && <div className="alert alert-error">Payment is due. NEPA keeps working until {fmtDate(s.graceUntil)}.</div>}
      {!e.serviceActive && <div className="alert alert-error">Your plan is not active, so NEPA is paused and calls go to your staff. Contact RedClinic to restart.</div>}
      <div className="grid2">
        <section className="card">
          <h2 className="h2">{plan?.name ?? "No plan"} {s?.simulated && <Simulated />}</h2>
          {plan && <p>{plan.description}</p>}
          <dl className="facts">
            {s?.status === "trialing" && <><dt>Trial ends</dt><dd>{fmtDate(s.trialEndsAt)}</dd></>}
            <dt>This period</dt><dd>{fmtDate(e.periodStart)} – {fmtDate(e.periodEnd)}</dd>
            <dt>Billing</dt><dd>{s?.period === "annual" ? "Yearly" : "Monthly"}{plan?.priceMonthlyPaise != null ? ` · ${rupees(s?.period === "annual" ? plan.priceAnnualPaise : plan.priceMonthlyPaise)} + GST` : ""}</dd>
            <dt>Calls</dt><dd>{e.outboundCalls ? "Incoming and outgoing" : "Incoming only"}</dd>
            <dt>Staff accounts</dt><dd>{staff} of {e.staffAccounts}</dd>
            {s?.cancelAtPeriodEnd && <><dt>Ends</dt><dd>At the end of this period</dd></>}
          </dl>
        </section>
        <section className="card">
          <h2 className="h2">Voice minutes</h2>
          <p className="metric-value">{e.minutesUsed} <span className="muted small">of {e.voiceMinutes}</span></p>
          <progress className="usage" max={100} value={pct} aria-label={`${pct}% used`} />
          <p className="small muted">Test calls are not counted. {plan?.overagePerMinutePaise ? `Extra minutes are ${rupees(plan.overagePerMinutePaise)} each + GST, billed with the next invoice.` : "Calls continue after the limit; RedClinic will contact you about extra minutes."}</p>
        </section>
      </div>
      <section className="card">
        <h2 className="h2">Invoices</h2>
        {invoices.length === 0 ? <Empty title="No invoices yet" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Invoice</th><th>For</th><th className="num">Amount</th><th className="num">GST</th><th className="num">Total</th><th>Status</th></tr></thead>
            <tbody>{invoices.map((i) => (
              <tr key={i.id}><td>{i.number}{i.simulated && <> <Simulated /></>}<div className="muted small">{fmtDate(i.issuedAt)}</div></td>
                <td className="small">{(i.items as { label: string }[]).map((x) => x.label).join(", ")}</td>
                <td className="num">{rupees(i.subtotalPaise)}</td><td className="num">{rupees(i.gstPaise)}</td><td className="num strong">{rupees(i.totalPaise)}</td>
                <td><Badge status={i.status === "paid" ? "active" : i.status === "failed" ? "failed" : "pending"} label={i.status === "issued" ? "To pay" : i.status} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
