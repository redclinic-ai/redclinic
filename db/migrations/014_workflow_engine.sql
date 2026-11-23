-- 014: Phase 6. Workflow definitions in one structured format, Core pack (every clinic type) and Dental Pack v2,
-- clinic copies with their own version history, master-update offers, and workflow runs for the engine.
--
-- Definition format (format 2):
-- { "trigger": { "event": "appointment_scheduled" | "appointment_no_show" | "appointment_completed"
--                         | "months_since_last_visit" | "weeks_since_last_visit" | "enquiry_without_booking",
--                "serviceMatch": ["root canal", ...]?, "months": 6?, "weeks": 4? },
--   "steps": [ { "key": "confirm", "afterMinutes": 0 | "beforeAppointmentMinutes": 180,
--                "action": "call" | "attention", "purpose": "confirmation" | ..., "onlyIf": "always" | "not_confirmed"
--                | "not_rebooked" | "no_upcoming", "script": "...", "reason": "..." } ] }

ALTER TABLE workflow_packs ADD COLUMN format int NOT NULL DEFAULT 1, ADD COLUMN notes text;
ALTER TABLE workflow_templates ADD COLUMN description text;

ALTER TABLE clinic_workflows
  ADD COLUMN template_key text,
  ADD COLUMN pack_key text,
  ADD COLUMN step_format int NOT NULL DEFAULT 1,
  ADD COLUMN description text,
  ADD COLUMN version int NOT NULL DEFAULT 1,
  ADD COLUMN updated_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN dismissed_pack_version int;                 -- "keep my version" for this master update
UPDATE clinic_workflows w SET template_key = t.key, pack_key = p.key
FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id WHERE t.id = w.source_template_id;

-- purposes used by workflows
ALTER TABLE calls DROP CONSTRAINT calls_purpose_check;
ALTER TABLE calls ADD CONSTRAINT calls_purpose_check CHECK (purpose IN ('enquiry','booking','confirmation','reminder','recall','follow_up','callback','no_show_followup','checkin','other'));
ALTER TABLE outbound_queue DROP CONSTRAINT outbound_queue_purpose_check;
ALTER TABLE outbound_queue ADD CONSTRAINT outbound_queue_purpose_check CHECK (purpose IN ('confirmation','reminder','recall','follow_up','callback','no_show_followup','checkin','other'));

-- every edit of a clinic's workflow is kept
CREATE TABLE clinic_workflow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  workflow_id uuid NOT NULL REFERENCES clinic_workflows(id) ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  steps jsonb NOT NULL,
  enabled boolean NOT NULL,
  automatic_enabled boolean NOT NULL,
  change_note text,
  edited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, version)
);
SELECT rc_enable_tenant_rls('clinic_workflow_versions');
REVOKE UPDATE, DELETE ON clinic_workflow_versions FROM rc_app;

-- ---------- packs: Core (all clinic types) v1 and Dental Pack v2, format 2 ----------
UPDATE workflow_packs SET is_active = false WHERE key = 'dental_pack' AND version = 1;

WITH core AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('core', 'all', 'Core workflows', 1, true, 'draft', 2, 'Installed for every clinic type.') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT core.id, t.key, t.name, t.description, t.steps::jsonb FROM core, (VALUES
 ('appointment_confirmation', 'Confirm appointments',
  'Calls patients about 3 hours before their appointment to check they are coming.',
  '{"trigger":{"event":"appointment_scheduled"},"steps":[
     {"key":"confirm","beforeAppointmentMinutes":180,"action":"call","purpose":"confirmation","onlyIf":"not_confirmed"}]}'),
 ('no_show_recovery', 'No-show follow-up',
  'If a patient does not come: a call right away and one about 5–6 hours later to rebook, then stop and tell staff.',
  '{"trigger":{"event":"appointment_no_show"},"steps":[
     {"key":"first","afterMinutes":0,"action":"call","purpose":"no_show_followup","onlyIf":"not_rebooked"},
     {"key":"second","afterMinutes":330,"action":"call","purpose":"no_show_followup","onlyIf":"not_rebooked"},
     {"key":"tell_staff","afterMinutes":1440,"action":"attention","reason":"No-show did not rebook after two calls.","onlyIf":"not_rebooked"}]}'),
 ('routine_recall', 'Six-month recall',
  'Six months after the last visit, if nothing is booked, offers a check-up.',
  '{"trigger":{"event":"months_since_last_visit","months":6},"steps":[
     {"key":"recall","afterMinutes":0,"action":"call","purpose":"recall","onlyIf":"no_upcoming"}]}'),
 ('enquiry_followup', 'Follow up enquiries',
  'A day after someone called but did not book, calls back to offer an appointment. Three days later, tells staff.',
  '{"trigger":{"event":"enquiry_without_booking"},"steps":[
     {"key":"call","afterMinutes":1440,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":5760,"action":"attention","reason":"Enquiry still not booked after a follow-up call.","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

WITH dental AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('dental_pack', 'dental', 'Dental Pack', 2, true, 'draft', 2,
          'Treatment workflows for dental clinics, on top of the Core workflows. Draft: needs review by a dental professional (KNOWN_ISSUES K4).') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT dental.id, t.key, t.name, t.description, t.steps::jsonb FROM dental, (VALUES
 ('post_procedure_checkin', 'Check-in after a procedure',
  'The day after an extraction, root canal, implant or surgery, asks how the patient feels. Pain or swelling goes to staff urgently.',
  '{"trigger":{"event":"appointment_completed","serviceMatch":["extraction","root canal","rct","implant","surgery","wisdom"]},"steps":[
     {"key":"checkin","afterMinutes":1440,"action":"call","purpose":"checkin","onlyIf":"always"}]}'),
 ('rct_next_visit', 'Root canal: book the next visit',
  'After a root canal visit, if the next visit is not booked within 3 days, calls to book it. After 10 days, tells staff.',
  '{"trigger":{"event":"appointment_completed","serviceMatch":["root canal","rct"]},"steps":[
     {"key":"book","afterMinutes":4320,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":14400,"action":"attention","reason":"Root canal patient has not booked the next visit.","onlyIf":"no_upcoming"}]}'),
 ('braces_adjustment', 'Braces adjustment reminder',
  'Four weeks after a braces visit, if nothing is booked, calls to book the adjustment. Three days later, tells staff.',
  '{"trigger":{"event":"weeks_since_last_visit","weeks":4,"serviceMatch":["braces","orthodontic","aligner"]},"steps":[
     {"key":"book","afterMinutes":0,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":4320,"action":"attention","reason":"Braces patient has not booked an adjustment.","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

-- install every active pack for the clinic's type, plus 'all' packs; never touches existing copies
CREATE OR REPLACE FUNCTION rc_install_pack(p_clinic uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  INSERT INTO clinic_workflows (clinic_id, source_template_id, source_pack_version, name, steps, template_key, pack_key, step_format, description)
  SELECT c.id, t.id, p.version, t.name, t.steps, t.key, p.key, p.format, t.description
  FROM clinics c
  JOIN workflow_packs p ON (p.clinic_type = c.clinic_type OR p.clinic_type = 'all') AND p.is_active
  JOIN workflow_templates t ON t.pack_id = p.id
  WHERE c.id = p_clinic
    AND NOT EXISTS (SELECT 1 FROM clinic_workflows w WHERE w.clinic_id = c.id AND w.template_key = t.key);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
-- existing clinics get the new templates they don't have; old format-1 copies stay as they are (not run)
SELECT rc_install_pack(id) FROM clinics;

-- a newer master template exists for a clinic copy (offered, never applied silently)
CREATE FUNCTION rc_workflow_master_update(p_workflow uuid)
RETURNS TABLE (template_id uuid, pack_version int, name text, steps jsonb, description text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, p.version, t.name, t.steps, t.description
  FROM clinic_workflows w
  JOIN workflow_packs p ON p.key = w.pack_key AND p.is_active
  JOIN workflow_templates t ON t.pack_id = p.id AND t.key = w.template_key
  WHERE w.id = p_workflow AND w.clinic_id = rc_clinic_id()
    AND (p.version > w.source_pack_version OR (p.format > w.step_format))
    AND p.version IS DISTINCT FROM w.dismissed_pack_version
$$;
GRANT EXECUTE ON FUNCTION rc_workflow_master_update(uuid) TO rc_app;

-- ---------- workflow runs (one per workflow and subject) ----------
CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  workflow_id uuid NOT NULL REFERENCES clinic_workflows(id) ON DELETE CASCADE,
  workflow_version int NOT NULL,
  subject_key text NOT NULL,                      -- e.g. appointment id, or patient id + date for recalls
  patient_id uuid NOT NULL REFERENCES patients(id),
  appointment_id uuid REFERENCES appointments(id),
  call_id uuid REFERENCES calls(id),
  anchor_at timestamptz NOT NULL,                 -- the time steps are measured from
  next_step int NOT NULL DEFAULT 0,
  next_due_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','stopped','failed')),
  stop_reason text,
  log jsonb NOT NULL DEFAULT '[]',
  is_simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, subject_key)
);
SELECT rc_enable_tenant_rls('workflow_runs');
SELECT rc_add_same_clinic('workflow_runs','patient_id','patients');
CREATE INDEX workflow_runs_due ON workflow_runs (clinic_id, status, next_due_at);

-- the engine runs without a user: these give it the facts it needs, in its clinic only
CREATE FUNCTION rc_wf_appointment(p_id uuid) RETURNS TABLE (status text, starts_at timestamptz, patient_id uuid, rebooked boolean, upcoming boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.status, a.starts_at, a.patient_id,
         EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.id <> a.id AND b.created_at > a.starts_at AND b.status <> 'cancelled'),
         EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = a.patient_id AND b.status IN ('scheduled','confirmed') AND b.starts_at > now())
  FROM appointments a WHERE a.id = p_id AND a.clinic_id = rc_clinic_id()
$$;
CREATE FUNCTION rc_wf_patient_upcoming(p_patient uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM appointments WHERE patient_id = p_patient AND clinic_id = rc_clinic_id() AND status IN ('scheduled','confirmed') AND starts_at > now())
$$;
-- candidates for each trigger (no patient details beyond ids and the service name)
CREATE FUNCTION rc_wf_candidates(p_event text, p_months int, p_weeks int, p_lookback interval)
RETURNS TABLE (subject_key text, patient_id uuid, appointment_id uuid, call_id uuid, anchor_at timestamptz, service text, is_simulated boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_event = 'appointment_scheduled' THEN
    RETURN QUERY SELECT a.id::text, a.patient_id, a.id, NULL::uuid, a.starts_at, s.name, false FROM appointments a LEFT JOIN clinic_services s ON s.id = a.service_id
      WHERE a.clinic_id = rc_clinic_id() AND a.status IN ('scheduled','confirmed') AND a.starts_at > now();
  ELSIF p_event = 'appointment_no_show' THEN
    RETURN QUERY SELECT a.id::text, a.patient_id, a.id, NULL::uuid, a.updated_at, s.name, false FROM appointments a LEFT JOIN clinic_services s ON s.id = a.service_id
      WHERE a.clinic_id = rc_clinic_id() AND a.status = 'no_show' AND a.updated_at > now() - p_lookback;
  ELSIF p_event = 'appointment_completed' THEN
    RETURN QUERY SELECT a.id::text, a.patient_id, a.id, NULL::uuid, a.updated_at, coalesce(s.name, a.reason), false FROM appointments a LEFT JOIN clinic_services s ON s.id = a.service_id
      WHERE a.clinic_id = rc_clinic_id() AND a.status = 'completed' AND a.updated_at > now() - p_lookback;
  ELSIF p_event IN ('months_since_last_visit','weeks_since_last_visit') THEN
    RETURN QUERY
      SELECT last.patient_id::text || ':' || to_char(last.starts_at, 'YYYY-MM-DD'), last.patient_id, last.id, NULL::uuid, now(), last.service, false
      FROM (SELECT DISTINCT ON (a.patient_id) a.patient_id, a.id, a.starts_at, coalesce(s.name, a.reason) AS service
            FROM appointments a LEFT JOIN clinic_services s ON s.id = a.service_id
            WHERE a.clinic_id = rc_clinic_id() AND a.status = 'completed' ORDER BY a.patient_id, a.starts_at DESC) last
      WHERE last.starts_at < now() - CASE WHEN p_event = 'months_since_last_visit' THEN make_interval(months => p_months) ELSE make_interval(weeks => p_weeks) END
        AND last.starts_at > now() - CASE WHEN p_event = 'months_since_last_visit' THEN make_interval(months => p_months) ELSE make_interval(weeks => p_weeks) END - p_lookback;
  ELSIF p_event = 'enquiry_without_booking' THEN
    RETURN QUERY SELECT c.id::text, c.patient_id, NULL::uuid, c.id, c.ended_at, NULL::text, c.is_simulated FROM calls c
      WHERE c.clinic_id = rc_clinic_id() AND c.patient_id IS NOT NULL AND c.direction = 'inbound' AND c.ended_at > now() - p_lookback
        AND c.intent IN ('booking','availability_question','question','faq','medical_question') AND coalesce(c.outcome,'') NOT IN ('booked','booking_requested')
        AND NOT EXISTS (SELECT 1 FROM appointments b WHERE b.patient_id = c.patient_id AND b.created_at > c.started_at);
  END IF;
END $$;
REVOKE ALL ON FUNCTION rc_wf_appointment(uuid), rc_wf_patient_upcoming(uuid), rc_wf_candidates(text,int,int,interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_wf_appointment(uuid), rc_wf_patient_upcoming(uuid), rc_wf_candidates(text,int,int,interval) TO rc_app;

-- clinic_workflows: NEPA (no user) must read them to run; edits still need edit_workflow
DROP POLICY cw_read ON clinic_workflows;
CREATE POLICY cw_read ON clinic_workflows FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
