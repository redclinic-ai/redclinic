-- 015: Phase 7. Plans (packages) with prices and limits, subscription lifecycle, invoices (billing history),
-- usage alerts, entitlement checks, clinic kill switch details, super admin helpers.
-- Money here is RedClinic's own subscription billing only (spec section 1). Amounts are in paise, GST separate.

ALTER TABLE packages
  ADD COLUMN code text,
  ADD COLUMN description text,
  ADD COLUMN price_monthly_paise bigint,
  ADD COLUMN price_annual_paise bigint,
  ADD COLUMN gst_percent numeric(5,2) NOT NULL DEFAULT 18,
  ADD COLUMN overage_per_minute_paise bigint,
  ADD COLUMN setup_fee_paise bigint,
  ADD COLUMN trial_days int NOT NULL DEFAULT 14,
  ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  ADD COLUMN sort int NOT NULL DEFAULT 0,
  ADD COLUMN notes text;
CREATE UNIQUE INDEX packages_code ON packages (code) WHERE code IS NOT NULL;

-- Planning figures from the founder (to be confirmed before launch: "pricing and plan limits for the MVP launch to be
-- decided later"). Annual = 11 months for 12. WhatsApp limits are stored for V2 and not enforced.
INSERT INTO packages (code, name, description, price_monthly_paise, price_annual_paise, limits, setup_fee_paise, status, sort, notes) VALUES
 ('starter', 'Starter', 'Incoming calls answered by NEPA, all clinic features.', 299900, 299900 * 11,
  '{"voice_minutes": 300, "outbound_calls": false, "staff_accounts": 5, "whatsapp_messages_v2": 700}', 999900, 'draft', 1, 'Planning figures; confirm before launch.'),
 ('growth', 'Growth', 'Incoming and outgoing calls: reminders, follow-ups and recalls.', 799900, 799900 * 11,
  '{"voice_minutes": 700, "outbound_calls": true, "staff_accounts": 10, "whatsapp_messages_v2": 1500}', 999900, 'draft', 2, 'Planning figures; confirm before launch.'),
 ('scale', 'Scale', 'For busy clinics and diagnostic centres.', 1299900, 1299900 * 11,
  '{"voice_minutes": 1200, "outbound_calls": true, "staff_accounts": 25, "whatsapp_messages_v2": 4000}', 999900, 'draft', 3, 'Planning figures; confirm before launch.')
ON CONFLICT DO NOTHING;

ALTER TABLE subscriptions
  ADD COLUMN started_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN current_period_start timestamptz,
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN setup_fee_waived boolean NOT NULL DEFAULT false,
  ADD COLUMN setup_fee_waiver_note text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- one live subscription per clinic
CREATE UNIQUE INDEX subscriptions_one_live ON subscriptions (clinic_id) WHERE status IN ('trialing','active','past_due','grace');

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  subscription_id uuid REFERENCES subscriptions(id),
  number text NOT NULL UNIQUE,
  description text NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  items jsonb NOT NULL DEFAULT '[]',     -- [{label, quantity, unit_paise, amount_paise}]
  subtotal_paise bigint NOT NULL,
  gst_paise bigint NOT NULL,
  total_paise bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('issued','paid','failed','void')),
  is_simulated boolean NOT NULL DEFAULT true,
  provider_ref text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY inv_read ON invoices FOR SELECT USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_billing')));
CREATE POLICY inv_write ON invoices FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE ON invoices TO rc_app;
CREATE SEQUENCE invoice_number_seq START 1001;
GRANT USAGE ON SEQUENCE invoice_number_seq TO rc_app;

CREATE TABLE usage_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  period_start timestamptz NOT NULL,
  threshold int NOT NULL CHECK (threshold IN (80, 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, period_start, threshold)
);
SELECT rc_enable_tenant_rls('usage_alerts');

ALTER TABLE clinics
  ADD COLUMN suspended_reason text,
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_by uuid REFERENCES users(id);

-- What a clinic may use right now. Runs without a user (calls, dialler), in the caller's clinic only.
-- No subscription yet = the trial a new clinic starts with (signup creates one; older clinics are treated the same).
CREATE FUNCTION rc_entitlements() RETURNS TABLE (
  plan_code text, plan_name text, status text, voice_minutes int, outbound_calls boolean, staff_accounts int,
  period_start timestamptz, period_end timestamptz, minutes_used int, service_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT s.*, p.code, p.name, p.limits FROM subscriptions s JOIN packages p ON p.id = s.package_id
    WHERE s.clinic_id = rc_clinic_id() ORDER BY (s.status IN ('trialing','active','past_due','grace')) DESC, s.created_at DESC LIMIT 1
  ), per AS (
    SELECT coalesce((SELECT current_period_start FROM s), date_trunc('month', now())) AS ps,
           coalesce((SELECT coalesce(current_period_end, trial_ends_at) FROM s), date_trunc('month', now()) + interval '1 month') AS pe
  )
  SELECT (SELECT code FROM s), (SELECT name FROM s), coalesce((SELECT status FROM s), 'none'),
         coalesce(((SELECT limits FROM s)->>'voice_minutes')::int, 0),
         coalesce(((SELECT limits FROM s)->>'outbound_calls')::boolean, false),
         coalesce(((SELECT limits FROM s)->>'staff_accounts')::int, 3),
         per.ps, per.pe,
         (SELECT coalesce(ceil(sum(quantity) / 60.0), 0)::int FROM usage_events u
          WHERE u.clinic_id = rc_clinic_id() AND u.kind = 'voice_seconds' AND NOT u.is_simulated AND u.occurred_at >= per.ps AND u.occurred_at < per.pe),
         coalesce((SELECT status IN ('trialing','active','past_due','grace') FROM s), false)
  FROM per
$$;
REVOKE ALL ON FUNCTION rc_entitlements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_entitlements() TO rc_app;

-- every new clinic starts a trial on Growth (status trialing); RedClinic changes the plan later
CREATE FUNCTION rc_start_trial_on_clinic() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p packages%ROWTYPE;
BEGIN
  SELECT * INTO p FROM packages WHERE code = 'growth';   -- trials include incoming and outgoing calls
  IF p.id IS NOT NULL THEN
    INSERT INTO subscriptions (clinic_id, package_id, billing_period, status, trial_ends_at, current_period_start, current_period_end, is_simulated)
    VALUES (NEW.id, p.id, 'monthly', 'trialing', now() + make_interval(days => p.trial_days), now(), now() + make_interval(days => p.trial_days), true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clinics_start_trial AFTER INSERT ON clinics FOR EACH ROW EXECUTE FUNCTION rc_start_trial_on_clinic();
INSERT INTO subscriptions (clinic_id, package_id, billing_period, status, trial_ends_at, current_period_start, current_period_end, is_simulated)
SELECT c.id, p.id, 'monthly', 'trialing', now() + interval '14 days', now(), now() + interval '14 days', true
FROM clinics c, packages p WHERE p.code = 'growth'
  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.clinic_id = c.id);

ALTER TABLE attention_items DROP CONSTRAINT attention_items_kind_check;
ALTER TABLE attention_items ADD CONSTRAINT attention_items_kind_check CHECK (kind IN (
    'call_not_completed','call_handed_over','unanswered_question','complaint',
    'reschedule_request','cancellation_request','unconfirmed_appointment',
    'no_show_no_rebooking','failed_outbound_call','pending_approval','failed_workflow','consent_withdrawn','usage_alert','billing'));
-- a usage alert for the clinic admin (Needs attention) at 80% and 100%; called after each call
CREATE FUNCTION rc_check_usage_alerts() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e record; t int;
BEGIN
  SELECT * INTO e FROM rc_entitlements();
  IF e.voice_minutes IS NULL OR e.voice_minutes = 0 THEN RETURN; END IF;
  FOREACH t IN ARRAY ARRAY[80, 100] LOOP
    IF e.minutes_used * 100 >= e.voice_minutes * t THEN
      INSERT INTO usage_alerts (clinic_id, period_start, threshold) VALUES (rc_clinic_id(), e.period_start, t) ON CONFLICT DO NOTHING;
      IF FOUND THEN
        INSERT INTO attention_items (clinic_id, kind, reason, urgency)
        VALUES (rc_clinic_id(), 'usage_alert',
          CASE WHEN t = 100 THEN 'Your plan''s voice minutes are used up (' || e.minutes_used || ' of ' || e.voice_minutes || '). Calls continue and extra minutes are billed. Contact RedClinic to change plan.'
               ELSE 'You have used ' || e.minutes_used || ' of ' || e.voice_minutes || ' voice minutes this period (80%).' END, 2)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION rc_check_usage_alerts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_check_usage_alerts() TO rc_app;
DROP INDEX attention_one_active;
-- one active item per subject; items with no subject (usage, billing, desk notes) are told apart by their wording
CREATE UNIQUE INDEX attention_one_active ON attention_items
  (clinic_id, kind, coalesce(appointment_id, call_id, approval_id, patient_id, '00000000-0000-0000-0000-000000000000'::uuid),
   (CASE WHEN coalesce(appointment_id, call_id, approval_id, patient_id) IS NULL THEN reason ELSE '' END))
  WHERE status <> 'resolved';

-- super admin: clinic overview counts (no patient details) for the clinics list
CREATE FUNCTION rc_admin_clinic_overview(p_since timestamptz)
RETURNS TABLE (clinic_id uuid, name text, clinic_type text, city text, status text, created_at timestamptz,
               plan text, sub_status text, calls bigint, appointments bigint, minutes bigint, staff bigint, patients bigint, last_call timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.name, c.clinic_type, c.city, c.status, c.created_at,
         (SELECT p.name FROM subscriptions s JOIN packages p ON p.id = s.package_id WHERE s.clinic_id = c.id ORDER BY s.created_at DESC LIMIT 1),
         (SELECT s.status FROM subscriptions s WHERE s.clinic_id = c.id ORDER BY s.created_at DESC LIMIT 1),
         (SELECT count(*) FROM calls x WHERE x.clinic_id = c.id AND NOT x.is_simulated AND x.started_at >= p_since),
         (SELECT count(*) FROM appointments a WHERE a.clinic_id = c.id AND a.created_at >= p_since),
         (SELECT coalesce(ceil(sum(quantity)/60.0),0)::bigint FROM usage_events u WHERE u.clinic_id = c.id AND u.kind='voice_seconds' AND NOT u.is_simulated AND u.occurred_at >= p_since),
         (SELECT count(*) FROM users u WHERE u.clinic_id = c.id AND u.status = 'active'),
         (SELECT count(*) FROM patients pt WHERE pt.clinic_id = c.id AND pt.merged_into IS NULL),
         (SELECT max(started_at) FROM calls x WHERE x.clinic_id = c.id AND NOT x.is_simulated)
  FROM clinics c WHERE rc_is_super() ORDER BY c.created_at DESC
$$;
GRANT EXECUTE ON FUNCTION rc_admin_clinic_overview(timestamptz) TO rc_app;

-- a RedClinic feature switch for the caller's clinic (default on)
CREATE FUNCTION rc_feature_enabled(p_feature text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce((SELECT enabled FROM clinic_features WHERE clinic_id = rc_clinic_id() AND feature = p_feature), true)
$$;
GRANT EXECUTE ON FUNCTION rc_feature_enabled(text) TO rc_app;
