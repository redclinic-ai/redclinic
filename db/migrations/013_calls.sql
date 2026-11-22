-- 013: Phase 5, calls. Live conversation state, provider references, recording details, transcription attempts,
-- idempotent telephony events, outbound call queue.

ALTER TABLE calls
  ADD COLUMN agent_id uuid REFERENCES nepa_agents(id),
  ADD COLUMN engine_state jsonb,                         -- conversation state while the call is live
  ADD COLUMN provider text NOT NULL DEFAULT 'simulated',
  ADD COLUMN provider_call_id text,
  ADD COLUMN language text,
  ADD COLUMN recording_status text NOT NULL DEFAULT 'none'
    CHECK (recording_status IN ('none','recording','stored','failed','not_permitted','caller_objected')),
  ADD COLUMN recording_format text,                      -- e.g. 'wav-pcm16-16khz-2ch' (lossless, 16 kHz, caller/NEPA on separate tracks)
  ADD COLUMN transcription_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN transcription_provider text,
  ADD COLUMN approval_id uuid REFERENCES approvals(id),  -- for outbound calls approved by staff
  ADD COLUMN test_call boolean NOT NULL DEFAULT false;   -- placed from the app's test-call mode
SELECT rc_add_same_clinic('calls','agent_id','nepa_agents');
SELECT rc_add_same_clinic('calls','approval_id','approvals');
CREATE UNIQUE INDEX calls_provider_id ON calls (provider, provider_call_id) WHERE provider_call_id IS NOT NULL;
CREATE INDEX calls_patient ON calls (patient_id, started_at DESC);
ALTER TABLE calls ADD CONSTRAINT calls_test_is_simulated CHECK (NOT test_call OR is_simulated);

-- staff with view_calls may correct transcripts; transcripts otherwise readable with view_call_transcripts (unchanged)
ALTER TABLE call_transcripts ADD COLUMN corrected_at timestamptz;
GRANT UPDATE (corrected_at) ON call_transcripts TO rc_app;

-- telephony webhook events, stored once (idempotency) before processing
CREATE TABLE telephony_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  clinic_id uuid REFERENCES clinics(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  UNIQUE (provider, provider_event_id)
);
ALTER TABLE telephony_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY te_super ON telephony_events FOR ALL USING (rc_is_super()) WITH CHECK (rc_is_super());
-- webhooks arrive before any clinic context exists: they are written through this function only
CREATE FUNCTION rc_telephony_event_record(p_provider text, p_event_id text, p_type text, p_payload jsonb, p_clinic uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO telephony_events (provider, provider_event_id, event_type, payload, clinic_id) VALUES (p_provider, p_event_id, p_type, p_payload, p_clinic);
  RETURN true;
EXCEPTION WHEN unique_violation THEN
  RETURN false;   -- already received: do nothing again
END $$;
CREATE FUNCTION rc_telephony_event_done(p_provider text, p_event_id text, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE telephony_events SET processed_at = now(), error = p_error WHERE provider = p_provider AND provider_event_id = p_event_id
$$;
-- which clinic owns a dialled number (the RedClinic number the clinic forwards to)
CREATE FUNCTION rc_clinic_for_number(p_number text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT clinic_id FROM clinic_phone_numbers
  WHERE status <> 'disabled' AND rc_phone_digits(receptionist_number) = rc_phone_digits(p_number) LIMIT 1
$$;
REVOKE ALL ON FUNCTION rc_telephony_event_record(text,text,text,jsonb,uuid), rc_telephony_event_done(text,text,text), rc_clinic_for_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_telephony_event_record(text,text,text,jsonb,uuid), rc_telephony_event_done(text,text,text), rc_clinic_for_number(text) TO rc_app;

-- outbound call queue (from approvals now, from workflows in Phase 6)
CREATE TABLE outbound_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  appointment_id uuid REFERENCES appointments(id),
  purpose text NOT NULL CHECK (purpose IN ('confirmation','reminder','recall','follow_up','callback','no_show_followup','other')),
  agent_kind text NOT NULL DEFAULT 'reminder',
  workflow_id uuid REFERENCES clinic_workflows(id),
  approval_id uuid REFERENCES approvals(id),
  callback_of uuid REFERENCES calls(id),
  due_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','awaiting_approval','calling','done','failed','cancelled','skipped')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  call_id uuid REFERENCES calls(id),
  is_simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_tenant_rls('outbound_queue');
SELECT rc_add_same_clinic('outbound_queue','patient_id','patients');
SELECT rc_add_same_clinic('outbound_queue','appointment_id','appointments');
CREATE INDEX outbound_due ON outbound_queue (clinic_id, status, due_at);
-- one live queue entry per patient, purpose and appointment
CREATE UNIQUE INDEX outbound_one_live ON outbound_queue (clinic_id, patient_id, purpose, coalesce(appointment_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('queued','awaiting_approval','calling');

-- read the calls for the clinic: view_calls; transcripts need view_call_transcripts (already in 003)
DROP POLICY c_read ON calls;
CREATE POLICY c_read ON calls FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)
         AND (rc_has_capability('view_calls') OR rc_user_id() IS NULL)));   -- no user = NEPA on a live call

-- Fix: c_write was FOR ALL, which also granted SELECT to every clinic member and bypassed view_calls.
DROP POLICY c_write ON calls;
CREATE POLICY c_insert ON calls FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY c_update ON calls FOR UPDATE
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND (rc_has_capability('view_calls') OR rc_user_id() IS NULL)))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));

-- what NEPA needs to place a call to a patient (name, phone, consent), nothing more
CREATE FUNCTION rc_nepa_patient_brief(p_patient uuid) RETURNS TABLE (name text, phone text, consent_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT name, phone, consent_status FROM patients WHERE id = p_patient AND clinic_id = rc_clinic_id() AND merged_into IS NULL
$$;
REVOKE ALL ON FUNCTION rc_nepa_patient_brief(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_nepa_patient_brief(uuid) TO rc_app;

-- the dialler (no user) moves approved calls to the queue and cancels rejected ones, in its clinic only
CREATE FUNCTION rc_outbound_sync_approvals() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbound_queue q SET status = 'queued' FROM approvals a
  WHERE q.clinic_id = rc_clinic_id() AND q.approval_id = a.id AND q.status = 'awaiting_approval' AND a.status IN ('approved','executed');
  UPDATE outbound_queue q SET status = 'cancelled', last_error = 'Rejected by staff' FROM approvals a
  WHERE q.clinic_id = rc_clinic_id() AND q.approval_id = a.id AND q.status = 'awaiting_approval' AND a.status = 'rejected';
$$;
REVOKE ALL ON FUNCTION rc_outbound_sync_approvals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_outbound_sync_approvals() TO rc_app;

-- the scheduler (no user) needs the list of active clinics to run each clinic's dialler
CREATE FUNCTION rc_active_clinic_ids() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT id FROM clinics WHERE status = 'active' $$;
REVOKE ALL ON FUNCTION rc_active_clinic_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_active_clinic_ids() TO rc_app;
