// RedClinic subscription billing (the only money in the product). Plans, subscriptions, invoices with GST,
// simulated payment events, plan limits. No payment gateway is active (founder approval needed, DECISIONS D2):
// all events are simulated and labelled so. A subscription only becomes active from a verified payment event,
// never from a browser redirect.
import { z } from "zod";
import type { PoolClient } from "pg";
import { withContext, type DbContext } from "../db";
import type { SignedInUser } from "../auth/service";
import { act, audit, can, UserError } from "../authz";

export const GRACE_DAYS = 7;
export const rupees = (paise: number | null | undefined) =>
  paise == null ? "—" : `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export interface Plan {
  id: string; code: string; name: string; description: string | null; status: string; priceMonthlyPaise: number | null; priceAnnualPaise: number | null;
  gstPercent: number; overagePerMinutePaise: number | null; setupFeePaise: number | null; trialDays: number;
  limits: { voice_minutes?: number; outbound_calls?: boolean; staff_accounts?: number; whatsapp_messages_v2?: number }; notes: string | null;
}
const toPlan = (x: Record<string, any>): Plan => ({
  id: x.id, code: x.code, name: x.name, description: x.description, status: x.status, priceMonthlyPaise: x.price_monthly_paise === null ? null : Number(x.price_monthly_paise),
  priceAnnualPaise: x.price_annual_paise === null ? null : Number(x.price_annual_paise), gstPercent: Number(x.gst_percent),
  overagePerMinutePaise: x.overage_per_minute_paise === null ? null : Number(x.overage_per_minute_paise), setupFeePaise: x.setup_fee_paise === null ? null : Number(x.setup_fee_paise),
  trialDays: x.trial_days, limits: x.limits ?? {}, notes: x.notes,
});

export interface Entitlements {
  planCode: string | null; planName: string | null; status: string; voiceMinutes: number; outboundCalls: boolean; staffAccounts: number;
  periodStart: Date; periodEnd: Date; minutesUsed: number; serviceActive: boolean;
}
export async function entitlements(c: PoolClient): Promise<Entitlements> {
  const e = (await c.query("SELECT * FROM rc_entitlements()")).rows[0];
  return { planCode: e.plan_code, planName: e.plan_name, status: e.status, voiceMinutes: e.voice_minutes, outboundCalls: e.outbound_calls,
    staffAccounts: e.staff_accounts, periodStart: e.period_start, periodEnd: e.period_end, minutesUsed: e.minutes_used, serviceActive: e.service_active };
}

// ---------- plans (super admin) ----------
export async function listPlans(actor: SignedInUser) {
  return act(actor, async (c) => (await c.query("SELECT * FROM packages WHERE code IS NOT NULL ORDER BY sort, name")).rows.map(toPlan));
}

const paise = z.union([z.literal(""), z.coerce.number().min(0).max(10_000_000)]).transform((v) => (v === "" ? null : Math.round(Number(v) * 100)));
const planSchema = z.object({
  name: z.string().trim().min(2).max(40), description: z.string().trim().max(300).default(""),
  priceMonthly: paise, priceAnnual: paise, overagePerMinute: paise, setupFee: paise,
  gstPercent: z.coerce.number().min(0).max(28), trialDays: z.coerce.number().int().min(0).max(90),
  voiceMinutes: z.coerce.number().int().min(0).max(100_000), outboundCalls: z.boolean(), staffAccounts: z.coerce.number().int().min(1).max(500),
  status: z.enum(["draft", "active", "retired"]), notes: z.string().trim().max(500).default(""),
});

export async function savePlan(actor: SignedInUser, id: string, input: z.input<typeof planSchema>) {
  return act(actor, async (c) => {
    if (!actor.isSuperAdmin) throw new UserError("Only RedClinic can change plans.");
    const p = planSchema.safeParse(input);
    if (!p.success) throw new UserError(p.error.issues[0].message, String(p.error.issues[0].path[0]));
    const d = p.data;
    if (d.status === "active" && (d.priceMonthly === null || d.priceAnnual === null)) throw new UserError("Set monthly and annual prices before making a plan active.");
    const cur = (await c.query("SELECT limits FROM packages WHERE id = $1", [id])).rows[0];
    if (!cur) throw new UserError("Plan not found.");
    const limits = { ...cur.limits, voice_minutes: d.voiceMinutes, outbound_calls: d.outboundCalls, staff_accounts: d.staffAccounts };
    await c.query(
      `UPDATE packages SET name=$2, description=$3, price_monthly_paise=$4, price_annual_paise=$5, overage_per_minute_paise=$6, setup_fee_paise=$7,
              gst_percent=$8, trial_days=$9, limits=$10, status=$11, notes=$12 WHERE id=$1`,
      [id, d.name, d.description || null, d.priceMonthly, d.priceAnnual, d.overagePerMinute, d.setupFee, d.gstPercent, d.trialDays, limits, d.status, d.notes || null]);
    await audit(c, actor, "plan_updated", "package", id, { status: d.status });
    return null;
  });
}

// ---------- invoices ----------
async function issueInvoice(c: PoolClient, sub: Record<string, any>, plan: Plan, opts: { periodStart: Date; periodEnd: Date; includeSetup: boolean; overageMinutes: number; simulated: boolean }) {
  const items: { label: string; quantity: number; unit_paise: number; amount_paise: number }[] = [];
  const price = sub.billing_period === "annual" ? plan.priceAnnualPaise : plan.priceMonthlyPaise;
  if (price === null) throw new UserError(`The ${plan.name} plan has no ${sub.billing_period} price yet.`);
  items.push({ label: `${plan.name} plan (${sub.billing_period === "annual" ? "12 months, pay for 11" : "1 month"})`, quantity: 1, unit_paise: price, amount_paise: price });
  if (opts.includeSetup && plan.setupFeePaise && !sub.setup_fee_waived) items.push({ label: "One-time setup and training", quantity: 1, unit_paise: plan.setupFeePaise, amount_paise: plan.setupFeePaise });
  if (opts.overageMinutes > 0 && plan.overagePerMinutePaise) items.push({ label: "Extra voice minutes (previous period)", quantity: opts.overageMinutes, unit_paise: plan.overagePerMinutePaise, amount_paise: opts.overageMinutes * plan.overagePerMinutePaise });
  const subtotal = items.reduce((s, i) => s + i.amount_paise, 0);
  const gst = Math.round((subtotal * plan.gstPercent) / 100);
  const n = (await c.query("SELECT nextval('invoice_number_seq') AS n")).rows[0].n;
  const r = await c.query(
    `INSERT INTO invoices (clinic_id, subscription_id, number, description, period_start, period_end, items, subtotal_paise, gst_paise, total_paise, status, is_simulated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'issued',$11) RETURNING id`,
    [sub.clinic_id, sub.id, `RC-${new Date().getFullYear()}-${n}`, `${plan.name} plan`, opts.periodStart, opts.periodEnd, JSON.stringify(items), subtotal, gst, subtotal + gst, opts.simulated]);
  return r.rows[0].id as string;
}

/** Super admin moves a clinic to a plan. Issues the first invoice; the plan becomes active when payment is confirmed. */
export async function assignPlan(actor: SignedInUser, clinicId: string, input: { planCode: string; period: "monthly" | "annual"; waiveSetup?: boolean; waiverNote?: string }) {
  return act(actor, async (c) => {
    if (!actor.isSuperAdmin) throw new UserError("Only RedClinic can change a clinic's plan.");
    const plan = (await c.query("SELECT * FROM packages WHERE code = $1", [input.planCode])).rows[0];
    if (!plan) throw new UserError("Plan not found.");
    if (!["monthly", "annual"].includes(input.period)) throw new UserError("Choose monthly or annual.");
    if (input.waiveSetup && (input.waiverNote ?? "").trim().length < 5) throw new UserError("Say why the setup fee is waived (e.g. the 3 references given).", "waiverNote");
    const live = (await c.query("SELECT * FROM subscriptions WHERE clinic_id = $1 AND status IN ('trialing','active','past_due','grace') FOR UPDATE", [clinicId])).rows[0];
    const hadPaid = (await c.query("SELECT 1 FROM invoices WHERE clinic_id = $1 AND status = 'paid' LIMIT 1", [clinicId])).rowCount;
    if (live) await c.query("UPDATE subscriptions SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = $1", [live.id]);
    const start = new Date();
    const end = new Date(start); if (input.period === "annual") end.setFullYear(end.getFullYear() + 1); else end.setMonth(end.getMonth() + 1);
    const sub = (await c.query(
      `INSERT INTO subscriptions (clinic_id, package_id, billing_period, status, current_period_start, current_period_end, is_simulated, setup_fee_waived, setup_fee_waiver_note)
       VALUES ($1,$2,$3,'past_due',$4,$5,true,$6,$7) RETURNING *`,
      [clinicId, plan.id, input.period, start, end, !!input.waiveSetup, input.waiverNote?.trim() || null])).rows[0];
    // until paid the clinic keeps working for the grace period
    await c.query("UPDATE subscriptions SET grace_until = now() + make_interval(days => $2), status = 'grace' WHERE id = $1", [sub.id, GRACE_DAYS]);
    const invoiceId = await issueInvoice(c, sub, toPlan(plan), { periodStart: start, periodEnd: end, includeSetup: !hadPaid, overageMinutes: 0, simulated: true });
    await audit(c, actor, "plan_assigned", "clinic", clinicId, { plan: input.planCode, period: input.period, waived: !!input.waiveSetup });
    return { subscriptionId: sub.id as string, invoiceId };
  });
}

// ---------- payment events (simulated provider; same path a real gateway's verified webhook will use) ----------
export type BillingEventType = "payment.succeeded" | "payment.failed" | "subscription.cancelled" | "subscription.resumed";
export interface BillingEvent { provider: string; eventId: string; type: BillingEventType; invoiceNumber: string; simulated: boolean }

const superCtx: DbContext = { userId: null, clinicId: null, isSuperAdmin: true };

/** Applies one payment event. Idempotent: the same event id twice does nothing the second time. */
export async function applyBillingEvent(e: BillingEvent) {
  return withContext(superCtx, async (c) => {
    const inv = (await c.query("SELECT * FROM invoices WHERE number = $1 FOR UPDATE", [e.invoiceNumber])).rows[0];
    if (!inv) throw new UserError("Invoice not found.");
    const fresh = (await c.query(
      "INSERT INTO subscription_events (clinic_id, provider, provider_event_id, event_type, payload, is_simulated) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
      [inv.clinic_id, e.provider, e.eventId, e.type, JSON.stringify(e), e.simulated])).rowCount;
    if (!fresh) return { duplicate: true as const };
    const sub = (await c.query("SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE", [inv.subscription_id])).rows[0];
    switch (e.type) {
      case "payment.succeeded":
        if (inv.status === "paid") break;
        await c.query("UPDATE invoices SET status='paid', paid_at=now(), provider_ref=$2 WHERE id=$1", [inv.id, e.eventId]);
        if (sub && ["trialing", "past_due", "grace", "active"].includes(sub.status)) {
          await c.query("UPDATE subscriptions SET status='active', grace_until=NULL, current_period_start=$2, current_period_end=$3, updated_at=now() WHERE id=$1",
            [sub.id, inv.period_start ?? sub.current_period_start, inv.period_end ?? sub.current_period_end]);
        }
        break;
      case "payment.failed":
        await c.query("UPDATE invoices SET status='failed' WHERE id=$1 AND status <> 'paid'", [inv.id]);
        if (sub && ["active", "trialing", "past_due", "grace"].includes(sub.status)) {
          // a failure starts the grace period once; it never extends one already running
          if (sub.status !== "grace") await c.query("UPDATE subscriptions SET status='grace', grace_until=now() + make_interval(days => $2), updated_at=now() WHERE id=$1", [sub.id, GRACE_DAYS]);
          const until = (await c.query("SELECT grace_until FROM subscriptions WHERE id = $1", [sub.id])).rows[0].grace_until as Date;
          await c.query(`INSERT INTO attention_items (clinic_id, kind, reason, urgency) VALUES ($1,'billing',$2,2) ON CONFLICT DO NOTHING`,
            [inv.clinic_id, `Payment for invoice ${inv.number} failed. RedClinic keeps working until ${until.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}; please pay before then.`]);
        }
        break;
      case "subscription.cancelled":
        if (sub) await c.query("UPDATE subscriptions SET cancel_at_period_end=true, updated_at=now() WHERE id=$1", [sub.id]);
        break;
      case "subscription.resumed":
        if (sub) await c.query("UPDATE subscriptions SET cancel_at_period_end=false, updated_at=now() WHERE id=$1", [sub.id]);
        break;
    }
    await c.query("INSERT INTO audit_log (clinic_id, actor_is_super, action, entity, entity_id, detail) VALUES ($1,true,$2,'invoice',$3,$4)",
      [inv.clinic_id, `billing_${e.type.replace(".", "_")}`, inv.id, { provider: e.provider, simulated: e.simulated }]);
    return { duplicate: false as const };
  });
}

/**
 * Daily billing job: ends trials, renews or expires subscriptions, ends grace periods. Renewal issues the next
 * invoice (with last period's extra minutes) and gives a grace period until it is paid.
 */
export async function billingTick(now = new Date()) {
  return withContext(superCtx, async (c) => {
    const changed: { clinicId: string; change: string }[] = [];
    // grace ran out
    for (const s of (await c.query("SELECT * FROM subscriptions WHERE status='grace' AND grace_until <= $1 FOR UPDATE", [now])).rows) {
      await c.query("UPDATE subscriptions SET status='expired', updated_at=now() WHERE id=$1", [s.id]);
      changed.push({ clinicId: s.clinic_id, change: "expired" });
    }
    // trials that ended without a paid plan
    for (const s of (await c.query("SELECT * FROM subscriptions WHERE status='trialing' AND trial_ends_at <= $1 FOR UPDATE", [now])).rows) {
      await c.query("UPDATE subscriptions SET status='expired', updated_at=now() WHERE id=$1", [s.id]);
      changed.push({ clinicId: s.clinic_id, change: "trial_ended" });
    }
    // active periods that ended
    for (const s of (await c.query("SELECT s.*, p.* , s.id AS sid FROM subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.status='active' AND s.current_period_end <= $1 FOR UPDATE OF s", [now])).rows) {
      if (s.cancel_at_period_end) {
        await c.query("UPDATE subscriptions SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1", [s.sid]);
        changed.push({ clinicId: s.clinic_id, change: "cancelled" });
        continue;
      }
      const used = (await c.query(
        "SELECT coalesce(ceil(sum(quantity)/60.0),0)::int AS m FROM usage_events WHERE clinic_id=$1 AND kind='voice_seconds' AND NOT is_simulated AND occurred_at >= $2 AND occurred_at < $3",
        [s.clinic_id, s.current_period_start, s.current_period_end])).rows[0].m;
      const overage = Math.max(0, used - (s.limits?.voice_minutes ?? 0));
      const start = new Date(s.current_period_end);
      const end = new Date(start); if (s.billing_period === "annual") end.setFullYear(end.getFullYear() + 1); else end.setMonth(end.getMonth() + 1);
      const sub = { ...s, id: s.sid };
      await issueInvoice(c, sub, toPlan(s), { periodStart: start, periodEnd: end, includeSetup: false, overageMinutes: overage, simulated: s.is_simulated });
      await c.query("UPDATE subscriptions SET status='grace', grace_until=$2::timestamptz + make_interval(days => $3), current_period_start=$4, current_period_end=$5, updated_at=now() WHERE id=$1",
        [s.sid, now, GRACE_DAYS, start, end]);
      changed.push({ clinicId: s.clinic_id, change: `renewal_invoiced${overage ? `_overage_${overage}` : ""}` });
    }
    return changed;
  });
}

// ---------- the clinic's own view ----------
export async function clinicBilling(actor: SignedInUser) {
  return act(actor, async (c) => {
    if (!(await can(c, "manage_billing"))) throw new UserError("Only the clinic admin can see the plan and invoices.");
    const ent = await entitlements(c);
    const sub = (await c.query(
      "SELECT s.*, p.name AS plan_name, p.code FROM subscriptions s JOIN packages p ON p.id = s.package_id ORDER BY s.created_at DESC LIMIT 1")).rows[0];
    const plan = sub ? toPlan((await c.query("SELECT * FROM packages WHERE id = $1", [sub.package_id])).rows[0]) : null;
    const invoices = (await c.query("SELECT * FROM invoices ORDER BY issued_at DESC LIMIT 50")).rows.map((x) => ({
      id: x.id, number: x.number, description: x.description, status: x.status, totalPaise: Number(x.total_paise), subtotalPaise: Number(x.subtotal_paise),
      gstPaise: Number(x.gst_paise), items: x.items, issuedAt: x.issued_at, paidAt: x.paid_at, periodStart: x.period_start, periodEnd: x.period_end, simulated: x.is_simulated,
    }));
    const staff = (await c.query("SELECT count(*)::int n FROM users WHERE status = 'active' AND role <> 'super_admin'")).rows[0].n;
    return { entitlements: ent, subscription: sub ? { status: sub.status, period: sub.billing_period, trialEndsAt: sub.trial_ends_at, graceUntil: sub.grace_until, cancelAtPeriodEnd: sub.cancel_at_period_end, simulated: sub.is_simulated } : null, plan, invoices, staff };
  });
}
