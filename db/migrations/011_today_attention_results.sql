-- 011: Phase 3. Needs Attention generation and handling, links needed for Results metrics (C8), Results v2.

-- ---------- links between calls and appointments (for "missed calls called back", "booked from follow-ups") ----------
ALTER TABLE calls
  ADD COLUMN purpose text CHECK (purpose IN ('enquiry','booking','confirmation','reminder','recall','follow_up','callback','no_show_followup','other')),
  ADD COLUMN callback_of uuid REFERENCES calls(id),          -- this call returns a missed call
  ADD COLUMN appointment_id uuid REFERENCES appointments(id), -- appointment the call was about
  ADD COLUMN workflow_id uuid REFERENCES clinic_workflows(id);
SELECT rc_add_same_clinic('calls','appointment_id','appointments');
SELECT rc_add_same_clinic('calls','callback_of','calls');
SELECT rc_add_same_clinic('calls','workflow_id','clinic_workflows');
ALTER TABLE appointments ADD COLUMN source_call_id uuid REFERENCES calls(id);  -- call during which it was booked
SELECT rc_add_same_clinic('appointments','source_call_id','calls');
CREATE INDEX calls_clinic_started ON calls (clinic_id, started_at);

-- ---------- Needs Attention ----------
ALTER TABLE attention_items
  ADD COLUMN resolution text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- at most one active item per (kind, subject): regeneration never duplicates
CREATE UNIQUE INDEX attention_one_active ON attention_items
  (clinic_id, kind, coalesce(appointment_id, call_id, approval_id, patient_id))
  WHERE status <> 'resolved';
CREATE INDEX attention_resolved_search ON attention_items (clinic_id, resolved_at DESC) WHERE status = 'resolved';

-- Creates items that come from appointment records (call- and approval-based items are created where those
-- events happen). Safe to run any number of times. Runs as the caller: row-level security applies.
--  * unconfirmed_appointment: starts within the next 24 hours and still not confirmed
--  * no_show_no_rebooking: a no-show more than 24 hours ago with no later appointment booked for that patient
CREATE FUNCTION rc_refresh_attention() RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0; k int;
BEGIN
  IF rc_clinic_id() IS NULL THEN RETURN 0; END IF;
  INSERT INTO attention_items (clinic_id, kind, patient_id, appointment_id, reason, urgency)
  SELECT a.clinic_id, 'unconfirmed_appointment', a.patient_id, a.id,
         'Appointment on ' || to_char(a.starts_at AT TIME ZONE cl.timezone, 'DD Mon at HH12:MI am') || ' is not confirmed yet.',
         CASE WHEN a.starts_at < now() + interval '3 hours' THEN 1 ELSE 2 END
  FROM appointments a JOIN clinics cl ON cl.id = a.clinic_id
  WHERE a.clinic_id = rc_clinic_id() AND a.status = 'scheduled'
    AND a.starts_at > now() AND a.starts_at < now() + interval '24 hours'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  INSERT INTO attention_items (clinic_id, kind, patient_id, appointment_id, reason, urgency)
  SELECT a.clinic_id, 'no_show_no_rebooking', a.patient_id, a.id,
         'Missed the appointment on ' || to_char(a.starts_at AT TIME ZONE cl.timezone, 'DD Mon') || ' and has not booked again.', 2
  FROM appointments a JOIN clinics cl ON cl.id = a.clinic_id
  WHERE a.clinic_id = rc_clinic_id() AND a.status = 'no_show'
    AND a.starts_at < now() - interval '24 hours' AND a.starts_at > now() - interval '30 days'
    AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.created_at > a.starts_at
                    AND b.status IN ('scheduled','confirmed','completed'))
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS k = ROW_COUNT; n := n + k;

  -- items whose reason has gone away close themselves
  UPDATE attention_items i SET status = 'resolved', resolved_at = now(), resolution = 'Resolved automatically: appointment confirmed, changed or done', updated_at = now()
  WHERE i.clinic_id = rc_clinic_id() AND i.kind = 'unconfirmed_appointment' AND i.status <> 'resolved'
    AND EXISTS (SELECT 1 FROM appointments a WHERE a.id = i.appointment_id AND a.status <> 'scheduled');
  UPDATE attention_items i SET status = 'resolved', resolved_at = now(), resolution = 'Resolved automatically: patient booked again', updated_at = now()
  WHERE i.clinic_id = rc_clinic_id() AND i.kind = 'no_show_no_rebooking' AND i.status <> 'resolved'
    AND EXISTS (SELECT 1 FROM appointments a JOIN appointments b ON b.patient_id = a.patient_id
                WHERE a.id = i.appointment_id AND b.created_at > a.starts_at AND b.status IN ('scheduled','confirmed','completed'));
  -- snoozes that have ended
  UPDATE attention_items SET status = 'open', snoozed_until = NULL, updated_at = now()
  WHERE clinic_id = rc_clinic_id() AND status = 'snoozed' AND snoozed_until <= now();
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION rc_refresh_attention() TO rc_app;

-- ---------- Results v2: every metric from the spec, counts only, explained ----------
CREATE FUNCTION rc_results(p_from timestamptz, p_to timestamptz, p_include_simulated boolean DEFAULT false)
RETURNS TABLE (metric text, value numeric)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT (rc_is_super() OR rc_has_capability('view_results')) THEN
    RAISE EXCEPTION 'view_results permission required';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT * FROM calls WHERE started_at >= p_from AND started_at < p_to AND (p_include_simulated OR NOT is_simulated)
      AND (rc_is_super() OR clinic_id = rc_clinic_id())
  ), a AS (
    SELECT * FROM appointments WHERE starts_at >= p_from AND starts_at < p_to AND (rc_is_super() OR clinic_id = rc_clinic_id())
  ), booked AS (   -- appointments created in the period (booking activity)
    SELECT * FROM appointments WHERE created_at >= p_from AND created_at < p_to AND (rc_is_super() OR clinic_id = rc_clinic_id())
  ), missed AS (
    SELECT * FROM c WHERE direction = 'inbound' AND status = 'missed'
  ), callbacks AS (
    SELECT DISTINCT cb.callback_of FROM calls cb
    WHERE cb.callback_of IN (SELECT id FROM missed) AND (p_include_simulated OR NOT cb.is_simulated)
  ), followups AS (
    SELECT * FROM c WHERE direction = 'outbound' AND purpose IN ('recall','follow_up','no_show_followup')
  ), noshow AS (
    SELECT * FROM a WHERE status = 'no_show'
  )
  SELECT 'calls_answered', count(*)::numeric FROM c WHERE direction = 'inbound' AND status <> 'missed'
  UNION ALL SELECT 'calls_handled_by_nepa', count(*) FROM c WHERE handled_by_nepa AND NOT handed_to_staff AND status = 'completed'
  UNION ALL SELECT 'calls_handed_to_staff', count(*) FROM c WHERE handed_to_staff
  UNION ALL SELECT 'calls_missed', count(*) FROM missed
  UNION ALL SELECT 'missed_calls_called_back', count(*) FROM callbacks
  UNION ALL SELECT 'appointments_from_missed_calls', count(*) FROM booked b
    WHERE b.source_call_id IN (SELECT id FROM calls WHERE callback_of IN (SELECT id FROM missed))
  UNION ALL SELECT 'appointments_booked_by_nepa', count(*) FROM booked WHERE booked_via = 'nepa'
  UNION ALL SELECT 'appointments_total', count(*) FROM a WHERE status <> 'cancelled'
  UNION ALL SELECT 'appointments_confirmed', count(*) FROM a WHERE status IN ('confirmed','completed')
  UNION ALL SELECT 'confirmation_rate_pct', CASE WHEN count(*) FILTER (WHERE status <> 'cancelled') = 0 THEN NULL
       ELSE round(100.0 * count(*) FILTER (WHERE status IN ('confirmed','completed')) / count(*) FILTER (WHERE status <> 'cancelled')) END FROM a
  UNION ALL SELECT 'appointments_completed', count(*) FROM a WHERE status = 'completed'
  UNION ALL SELECT 'no_shows', count(*) FROM noshow
  UNION ALL SELECT 'no_shows_rebooked', count(*) FROM noshow n WHERE EXISTS (
       SELECT 1 FROM appointments b WHERE b.patient_id = n.patient_id AND b.created_at > n.starts_at AND b.status <> 'cancelled')
  UNION ALL SELECT 'followup_calls', count(*) FROM followups
  UNION ALL SELECT 'visits_booked_from_followups', count(*) FROM booked b WHERE b.source_call_id IN (SELECT id FROM followups)
  UNION ALL SELECT 'voice_minutes_used', coalesce(ceil(sum(duration_seconds) / 60.0), 0) FROM c
  UNION ALL SELECT 'new_patients', count(*) FROM patients
       WHERE registered_at >= p_from AND registered_at < p_to AND merged_into IS NULL AND (rc_is_super() OR clinic_id = rc_clinic_id());
END $$;
GRANT EXECUTE ON FUNCTION rc_results(timestamptz, timestamptz, boolean) TO rc_app;

-- a second withdrawal while the first alert is still open must not fail the consent record
CREATE OR REPLACE FUNCTION rc_sync_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE patients SET consent_status = NEW.status WHERE id = NEW.patient_id;
  IF NEW.status = 'withdrawn' THEN
    INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency)
    VALUES (NEW.clinic_id, 'consent_withdrawn', NEW.patient_id,
            'Patient withdrew consent. Automatic calls and reminders are stopped for this patient.', 2)
    ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO audit_log (clinic_id, actor_user_id, action, entity, entity_id, detail)
  VALUES (NEW.clinic_id, NEW.recorded_by, 'consent_' || NEW.status, 'patient', NEW.patient_id::text,
          jsonb_build_object('method', NEW.method, 'wording_version', NEW.wording_version));
  RETURN NEW;
END $$;

-- ---------- clinic phone numbers (call forwarding to the AI receptionist, with a human fallback) ----------
CREATE TABLE clinic_phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  clinic_number text NOT NULL,                 -- the number patients already call
  receptionist_number text,                    -- RedClinic number the clinic forwards to (from the telephony provider)
  fallback_number text,                        -- a staff mobile the AI hands over to
  forwarding_mode text NOT NULL DEFAULT 'when_busy_or_unanswered' CHECK (forwarding_mode IN ('always','when_busy_or_unanswered','after_hours')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','disabled')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_settings_rls('clinic_phone_numbers');
