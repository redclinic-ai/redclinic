-- 003: calls, approvals, attention items, workflow packs, packages, subscriptions, usage.
-- Billing tables hold RedClinic's own subscription data only. No clinic revenue (decision D5).

-- ---------- calls ----------
CREATE TABLE calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid REFERENCES patients(id),                 -- only when identification is reliable
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  is_simulated boolean NOT NULL DEFAULT false,
  caller_number text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds int,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','completed','missed','failed','handed_to_staff')),
  handled_by_nepa boolean NOT NULL DEFAULT true,
  handed_to_staff boolean NOT NULL DEFAULT false,
  recording_ref text,
  transcription_status text NOT NULL DEFAULT 'pending'
    CHECK (transcription_status IN ('pending','completed','failed','unavailable')),
  transcription_error text,
  intent text,
  outcome text,
  summary text,
  follow_up text,
  actions_executed jsonb NOT NULL DEFAULT '[]',
  config_versions jsonb NOT NULL DEFAULT '{}',             -- policy, clinic and agent versions used
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_clinic_time ON calls (clinic_id, started_at DESC);
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY c_read ON calls FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('view_calls')));
CREATE POLICY c_write ON calls FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
GRANT SELECT, INSERT, UPDATE ON calls TO rc_app;

-- Transcript segments: the recognised text is never overwritten; human corrections are separate.
CREATE TABLE call_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  call_id uuid NOT NULL REFERENCES calls(id),
  seq int NOT NULL,
  speaker text NOT NULL CHECK (speaker IN ('nepa','caller','staff')),
  language text,
  text_original text NOT NULL,
  text_corrected text,
  corrected_by uuid REFERENCES users(id),
  at_ms int,
  UNIQUE (call_id, seq)
);
ALTER TABLE call_transcripts ENABLE ROW LEVEL SECURITY;
CREATE POLICY ct_read ON call_transcripts FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('view_call_transcripts')));
CREATE POLICY ct_write ON call_transcripts FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY ct_correct ON call_transcripts FOR UPDATE
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('view_call_transcripts')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('view_call_transcripts')));
GRANT SELECT, INSERT ON call_transcripts TO rc_app;
GRANT UPDATE (text_corrected, corrected_by) ON call_transcripts TO rc_app;

-- ---------- approvals ----------
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  requested_by text NOT NULL,                              -- 'nepa' or a user id
  action_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  mode text NOT NULL DEFAULT 'approval_required' CHECK (mode IN ('suggest','approval_required','automatic')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  failure_detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY ap_read ON approvals FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND (rc_has_capability('view_approvals') OR rc_has_capability('approve_actions'))));
CREATE POLICY ap_insert ON approvals FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY ap_decide ON approvals FOR UPDATE
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('approve_actions')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('approve_actions')));
GRANT SELECT, INSERT, UPDATE ON approvals TO rc_app;

-- ---------- Needs attention ----------
CREATE TABLE attention_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  kind text NOT NULL CHECK (kind IN (
    'call_not_completed','call_handed_over','unanswered_question','complaint',
    'reschedule_request','cancellation_request','unconfirmed_appointment',
    'no_show_no_rebooking','failed_outbound_call','pending_approval','failed_workflow')),
  patient_id uuid REFERENCES patients(id),
  call_id uuid REFERENCES calls(id),
  appointment_id uuid REFERENCES appointments(id),
  approval_id uuid REFERENCES approvals(id),
  reason text NOT NULL,
  urgency int NOT NULL DEFAULT 2 CHECK (urgency BETWEEN 1 AND 3),   -- 1 = urgent
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','snoozed','resolved')),
  assigned_to uuid REFERENCES users(id),
  snoozed_until timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  is_simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attention_open ON attention_items (clinic_id, status, urgency, created_at);
ALTER TABLE attention_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_read ON attention_items FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('manage_attention')));
CREATE POLICY ai_insert ON attention_items FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY ai_update ON attention_items FOR UPDATE
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_attention')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_attention')));
GRANT SELECT, INSERT, UPDATE ON attention_items TO rc_app;

-- ---------- workflow packs (master data) and clinic copies ----------
CREATE TABLE workflow_packs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  clinic_type text NOT NULL,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (key, version)
);
CREATE TABLE workflow_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES workflow_packs(id),
  key text NOT NULL,
  name text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]',
  UNIQUE (pack_id, key)
);
-- Master data: everyone may read, only super admin may change.
ALTER TABLE workflow_packs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY wp_read ON workflow_packs FOR SELECT USING (true);
CREATE POLICY wp_write ON workflow_packs FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
CREATE POLICY wt_read ON workflow_templates FOR SELECT USING (true);
CREATE POLICY wt_write ON workflow_templates FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE ON workflow_packs, workflow_templates TO rc_app;

-- Editable clinic copy. Editing it never touches the master template.
CREATE TABLE clinic_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  source_template_id uuid REFERENCES workflow_templates(id),
  source_pack_version int,
  name text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]',
  enabled boolean NOT NULL DEFAULT true,
  automatic_enabled boolean NOT NULL DEFAULT false,        -- automatic mode needs explicit clinic admin opt-in
  edited_by_clinic boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE clinic_workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY cw_read ON clinic_workflows FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY cw_write ON clinic_workflows FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('edit_workflow')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('edit_workflow')));
GRANT SELECT, INSERT, UPDATE, DELETE ON clinic_workflows TO rc_app;

-- Copy the active pack for a clinic's type into the clinic's own editable workflows.
CREATE FUNCTION rc_install_pack(p_clinic uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO clinic_workflows (clinic_id, source_template_id, source_pack_version, name, steps)
  SELECT c.id, t.id, p.version, t.name, t.steps
  FROM clinics c
  JOIN workflow_packs p ON p.clinic_type = c.clinic_type AND p.is_active
  JOIN workflow_templates t ON t.pack_id = p.id
  WHERE c.id = p_clinic
    AND NOT EXISTS (SELECT 1 FROM clinic_workflows w WHERE w.clinic_id = c.id AND w.source_template_id = t.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
-- (Dental Pack content is not loaded: the Dental Pack specification has not been supplied. See KNOWN_ISSUES K2.)

-- ---------- packages, subscriptions, usage (RedClinic's own billing only) ----------
CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  limits jsonb NOT NULL DEFAULT '{}',                      -- voice minutes, staff accounts, features
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY pk_read ON packages FOR SELECT USING (true);
CREATE POLICY pk_write ON packages FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE ON packages TO rc_app;

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  package_id uuid NOT NULL REFERENCES packages(id),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly','annual')),
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing','active','past_due','grace','cancelled','expired')),
  current_period_end timestamptz,
  grace_until timestamptz,
  is_simulated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY sub_read ON subscriptions FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_billing')));
CREATE POLICY sub_write ON subscriptions FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE ON subscriptions TO rc_app;

-- Payment events: unique event id makes webhook handling idempotent.
CREATE TABLE subscription_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  is_simulated boolean NOT NULL DEFAULT true,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY se_super ON subscription_events FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT ON subscription_events TO rc_app;

CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  kind text NOT NULL CHECK (kind IN ('voice_seconds','call','assistant_message','storage_bytes')),
  quantity bigint NOT NULL,
  is_simulated boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_tenant_rls('usage_events');
GRANT USAGE ON SEQUENCE usage_events_id_seq TO rc_app;
