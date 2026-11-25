-- 019 (V2): WhatsApp channel.
-- Clinic connection settings, patient opt-in, a message log (both directions), WhatsApp workflow steps
-- (format 2 gains action "whatsapp" and condition "was_confirmed"), and a "WhatsApp pack" of workflows that clinics
-- switch on once WhatsApp is connected. Message wording lives in code (src/lib/whatsapp/templates.ts) because
-- WhatsApp only delivers pre-approved templates outside a 24-hour reply window.

-- ---------- clinic connection ----------
CREATE TABLE clinic_whatsapp (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'off' CHECK (status IN ('off','simulated','connected')),
  provider text NOT NULL DEFAULT 'simulated',
  business_number text,                 -- the clinic's WhatsApp number, digits with country code
  phone_number_id text,                 -- provider's id for that number (Meta Cloud API)
  maps_url text CHECK (maps_url IS NULL OR maps_url ~ '^https://'),
  review_url text CHECK (review_url IS NULL OR review_url ~ '^https://'),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_settings_rls('clinic_whatsapp');
CREATE UNIQUE INDEX clinic_whatsapp_number ON clinic_whatsapp (business_number) WHERE business_number IS NOT NULL AND status <> 'off';

-- ---------- patient opt-in (WhatsApp rules: business messages only to people who agreed) ----------
ALTER TABLE patients
  ADD COLUMN whatsapp_status text NOT NULL DEFAULT 'unknown' CHECK (whatsapp_status IN ('unknown','opted_in','opted_out')),
  ADD COLUMN whatsapp_status_at timestamptz,
  ADD COLUMN whatsapp_status_by text,   -- 'staff:<user id>', 'patient', 'import'
  ADD COLUMN preferred_language text CHECK (preferred_language IN ('en','hi','kn'));  -- for messages; calls detect language

-- appointments remember when they were confirmed, so a no-show of a confirmed patient can be told apart
ALTER TABLE appointments ADD COLUMN confirmed_at timestamptz;
CREATE FUNCTION rc_appointment_confirmed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'confirmed' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'confirmed') AND NEW.confirmed_at IS NULL THEN
    NEW.confirmed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_confirmed_at BEFORE INSERT OR UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION rc_appointment_confirmed_at();
UPDATE appointments SET confirmed_at = updated_at WHERE status = 'confirmed';

-- ---------- messages ----------
CREATE TABLE whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid REFERENCES patients(id),
  direction text NOT NULL CHECK (direction IN ('out','in')),
  template_key text,                    -- outgoing template, or NULL for a free reply inside the 24-hour window
  language text NOT NULL DEFAULT 'en',
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_approval','queued','sent','delivered','read','failed','skipped','cancelled','received')),
  peer_number text NOT NULL,            -- the patient's number, digits with country code
  provider text NOT NULL DEFAULT 'simulated',
  provider_message_id text,
  appointment_id uuid REFERENCES appointments(id),
  workflow_id uuid REFERENCES clinic_workflows(id),
  approval_id uuid REFERENCES approvals(id),
  sent_by uuid REFERENCES users(id),    -- staff reply; NULL for NEPA and workflows
  intent text,                          -- incoming: what the reply meant (confirm, change, stop, ...)
  handled_at timestamptz,               -- incoming: staff marked it handled
  error text,
  due_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  is_simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_messages_provider_id ON whatsapp_messages (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX whatsapp_messages_patient ON whatsapp_messages (clinic_id, patient_id, created_at DESC);
CREATE INDEX whatsapp_messages_due ON whatsapp_messages (clinic_id, due_at) WHERE status = 'queued';
-- one workflow message per step per subject (the engine may retry a tick)
CREATE UNIQUE INDEX whatsapp_messages_once ON whatsapp_messages (workflow_id, appointment_id, patient_id, template_key)
  WHERE workflow_id IS NOT NULL AND status <> 'cancelled';
SELECT rc_enable_patient_rls('whatsapp_messages');

-- NEPA and the webhook run without a user. They need: the clinic for a business number, the patient for a phone
-- number, and to record opt-in/out and confirm an appointment from a reply. Nothing else.
CREATE FUNCTION rc_whatsapp_clinic_for_number(p_number text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT w.clinic_id FROM clinic_whatsapp w JOIN clinics c ON c.id = w.clinic_id
   WHERE w.business_number = regexp_replace(p_number, '\D', '', 'g') AND w.status <> 'off' AND c.status = 'active'
$$;

CREATE FUNCTION rc_whatsapp_patient(p_number text)
RETURNS TABLE (id uuid, name text, preferred_language text, whatsapp_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- match on the last 10 digits (Indian mobile numbers are stored in many shapes)
  SELECT p.id, p.name, p.preferred_language, p.whatsapp_status FROM patients p
   WHERE p.clinic_id = rc_clinic_id() AND p.merged_into IS NULL
     AND right(rc_phone_digits(p.phone), 10) = right(regexp_replace(p_number, '\D', '', 'g'), 10)
   ORDER BY p.registered_at LIMIT 1
$$;

CREATE FUNCTION rc_whatsapp_set_status(p_patient uuid, p_status text, p_by text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE patients SET whatsapp_status = p_status, whatsapp_status_at = now(), whatsapp_status_by = p_by
   WHERE id = p_patient AND clinic_id = rc_clinic_id() AND p_status IN ('opted_in','opted_out')
$$;

-- a "1" reply to a confirmation message confirms that appointment (only if it is still upcoming and unconfirmed)
CREATE FUNCTION rc_whatsapp_confirm_appointment(p_appointment uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE appointments SET status = 'confirmed', updated_at = now()
   WHERE id = p_appointment AND clinic_id = rc_clinic_id() AND status = 'scheduled' AND starts_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail)
    VALUES (rc_clinic_id(), NULL, false, 'appointment_confirmed_by_whatsapp', 'appointment', p_appointment::text, '{}');
  END IF;
  RETURN n > 0;
END $$;

-- approvals decided by staff move waiting messages to the send queue (same idea as rc_outbound_sync_approvals)
CREATE FUNCTION rc_whatsapp_sync_approvals() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE whatsapp_messages m SET status = 'queued' FROM approvals a
   WHERE m.clinic_id = rc_clinic_id() AND m.approval_id = a.id AND m.status = 'awaiting_approval' AND a.status IN ('approved','executed');
  UPDATE whatsapp_messages m SET status = 'cancelled', error = 'Rejected by staff' FROM approvals a
   WHERE m.clinic_id = rc_clinic_id() AND m.approval_id = a.id AND m.status = 'awaiting_approval' AND a.status = 'rejected';
$$;

-- messages sent this billing period, and the plan's allowance (NULL = not limited)
CREATE FUNCTION rc_whatsapp_allowance() RETURNS TABLE (allowance int, used int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH e AS (SELECT * FROM rc_entitlements()),
  l AS (SELECT p.limits FROM subscriptions s JOIN packages p ON p.id = s.package_id
         WHERE s.clinic_id = rc_clinic_id() ORDER BY (s.status IN ('trialing','active','past_due','grace')) DESC, s.created_at DESC LIMIT 1)
  SELECT coalesce((SELECT limits->>'whatsapp_messages' FROM l), (SELECT limits->>'whatsapp_messages_v2' FROM l))::int,
         (SELECT count(*) FROM whatsapp_messages m, e WHERE m.clinic_id = rc_clinic_id() AND m.direction = 'out'
            AND m.status IN ('sent','delivered','read') AND NOT m.is_simulated AND m.sent_at >= e.period_start AND m.sent_at < e.period_end)::int
$$;

REVOKE ALL ON FUNCTION rc_whatsapp_clinic_for_number(text), rc_whatsapp_patient(text), rc_whatsapp_set_status(uuid, text, text),
  rc_whatsapp_confirm_appointment(uuid), rc_whatsapp_sync_approvals(), rc_whatsapp_allowance() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_whatsapp_clinic_for_number(text), rc_whatsapp_patient(text), rc_whatsapp_set_status(uuid, text, text),
  rc_whatsapp_confirm_appointment(uuid), rc_whatsapp_sync_approvals(), rc_whatsapp_allowance() TO rc_app;

-- ---------- Needs attention: WhatsApp replies that need a person ----------
ALTER TABLE attention_items DROP CONSTRAINT attention_items_kind_check;
ALTER TABLE attention_items ADD CONSTRAINT attention_items_kind_check CHECK (kind IN (
    'call_not_completed','call_handed_over','unanswered_question','complaint',
    'reschedule_request','cancellation_request','unconfirmed_appointment',
    'no_show_no_rebooking','failed_outbound_call','pending_approval','failed_workflow','consent_withdrawn','usage_alert','billing',
    'whatsapp_reply'));

-- ---------- workflow helpers: "was_confirmed" needs confirmed_at ----------
DROP FUNCTION rc_wf_appointment(uuid);
CREATE FUNCTION rc_wf_appointment(p_id uuid)
RETURNS TABLE (status text, starts_at timestamptz, patient_id uuid, rebooked boolean, upcoming boolean, was_confirmed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.status, a.starts_at, a.patient_id,
         EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.id <> a.id AND b.created_at > a.starts_at AND b.status <> 'cancelled'),
         EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.status IN ('scheduled','confirmed') AND b.starts_at > now()),
         a.confirmed_at IS NOT NULL
  FROM appointments a WHERE a.id = p_id AND a.clinic_id = rc_clinic_id()
$$;
REVOKE ALL ON FUNCTION rc_wf_appointment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_wf_appointment(uuid) TO rc_app;

-- ---------- WhatsApp pack (all clinic types). Installed switched off; clinics turn workflows on after connecting. ----------
WITH wa AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('whatsapp', 'all', 'WhatsApp workflows', 1, true, 'draft', 2,
          'Messages patients on WhatsApp. Needs WhatsApp connected in Settings and the patient''s opt-in.') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT wa.id, t.key, t.name, t.description, t.steps::jsonb FROM wa, (VALUES
 ('wa_confirmation', 'WhatsApp: confirm appointments',
  'A day before the appointment, sends a WhatsApp message. Patients reply 1 to confirm or 2 to change.',
  '{"trigger":{"event":"appointment_scheduled"},"steps":[
     {"key":"confirm","beforeAppointmentMinutes":1440,"action":"whatsapp","template":"appointment_confirmation","onlyIf":"not_confirmed"}]}'),
 ('wa_no_show_confirmed', 'WhatsApp: confirmed patient did not come',
  'If a patient who had confirmed does not come, sends the clinic location and an offer to rebook (founder''s rule: call unconfirmed patients, message confirmed ones).',
  '{"trigger":{"event":"appointment_no_show"},"steps":[
     {"key":"location","afterMinutes":0,"action":"whatsapp","template":"no_show_location","onlyIf":"was_confirmed"},
     {"key":"tell_staff","afterMinutes":1440,"action":"attention","reason":"Confirmed patient missed the appointment and has not rebooked after the WhatsApp message.","onlyIf":"not_rebooked"}]}'),
 ('wa_checkin', 'WhatsApp: check-in after treatment',
  'The day after a visit, asks how the patient is feeling. Worrying replies go to staff.',
  '{"trigger":{"event":"appointment_completed"},"steps":[
     {"key":"checkin","afterMinutes":1440,"action":"whatsapp","template":"post_visit_checkin","onlyIf":"always"}]}'),
 ('wa_next_visit', 'WhatsApp: next visit reminder',
  'Six months after the last visit, if nothing is booked, invites the patient to book. Reply 1 and NEPA calls to book.',
  '{"trigger":{"event":"months_since_last_visit","months":6},"steps":[
     {"key":"invite","afterMinutes":0,"action":"whatsapp","template":"next_visit","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

-- packs can be installed switched off (the WhatsApp pack: nothing to send until WhatsApp is connected)
ALTER TABLE workflow_packs ADD COLUMN install_enabled boolean NOT NULL DEFAULT true;
UPDATE workflow_packs SET install_enabled = false WHERE key = 'whatsapp';
CREATE OR REPLACE FUNCTION rc_install_pack(p_clinic uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO clinic_workflows (clinic_id, source_template_id, source_pack_version, name, steps, template_key, pack_key, step_format, description, enabled)
  SELECT c.id, t.id, p.version, t.name, t.steps, t.key, p.key, p.format, t.description, p.install_enabled
  FROM clinics c
  JOIN workflow_packs p ON (p.clinic_type = c.clinic_type OR p.clinic_type = 'all') AND p.is_active
  JOIN workflow_templates t ON t.pack_id = p.id
  WHERE c.id = p_clinic
    AND NOT EXISTS (SELECT 1 FROM clinic_workflows w WHERE w.clinic_id = c.id AND w.template_key = t.key);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
SELECT rc_install_pack(id) FROM clinics;

-- delivery receipts (sent → delivered → read, or failed) carry only the provider's message id
CREATE FUNCTION rc_whatsapp_status_update(p_provider_id text, p_status text, p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE whatsapp_messages SET status = p_status, error = coalesce(p_error, error)
   WHERE provider_message_id = p_provider_id AND direction = 'out' AND p_status IN ('sent','delivered','read','failed')
     -- never move backwards (a late "sent" after "read")
     AND array_position(ARRAY['queued','sent','delivered','read'], status) < coalesce(array_position(ARRAY['queued','sent','delivered','read'], p_status), 99);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0 OR EXISTS (SELECT 1 FROM whatsapp_messages WHERE provider_message_id = p_provider_id);
END $$;
REVOKE ALL ON FUNCTION rc_whatsapp_status_update(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_whatsapp_status_update(text, text, text) TO rc_app;
