-- 020 (V2): Meta lead ads into RedClinic, and Google review requests.
-- Lead ads: a clinic links its Meta lead form; each new lead becomes (or matches) a patient record and a lead row,
-- and the "lead received" workflow event lets NEPA call (and WhatsApp, with opt-in) within minutes.
-- Reviews: a WhatsApp review request after a visit, to every patient alike (no filtering by satisfaction, which
-- Google forbids), at most once in 6 months per patient, with a tracked link so clinics see clicks.

-- ---------- lead forms (settings) ----------
CREATE TABLE lead_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta')),
  page_id text NOT NULL CHECK (page_id ~ '^\d{3,30}$'),
  form_id text NOT NULL CHECK (form_id ~ '^\d{3,30}$'),
  label text NOT NULL CHECK (length(label) BETWEEN 2 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, form_id)
);
SELECT rc_enable_settings_rls('lead_forms');

-- ---------- leads (patient data) ----------
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  source text NOT NULL CHECK (source IN ('meta_lead_ad','manual')),
  provider_lead_id text,
  form_id uuid REFERENCES lead_forms(id),
  patient_id uuid REFERENCES patients(id),
  name text NOT NULL,
  phone text,
  email text,
  answers jsonb NOT NULL DEFAULT '{}',      -- the form's other questions and answers, as given
  campaign jsonb NOT NULL DEFAULT '{}',     -- ad, ad set, campaign ids/names when the provider sends them
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','not_interested','duplicate')),
  status_by uuid REFERENCES users(id),
  status_at timestamptz,
  is_simulated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, provider_lead_id)
);
CREATE INDEX leads_clinic_created ON leads (clinic_id, created_at DESC);
SELECT rc_enable_patient_rls('leads');

-- The webhook has no user: find the clinic for a form, then record the lead and match or create the patient.
CREATE FUNCTION rc_lead_form_clinic(p_provider text, p_form_id text) RETURNS TABLE (clinic_id uuid, form uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.clinic_id, f.id FROM lead_forms f JOIN clinics c ON c.id = f.clinic_id
   WHERE f.provider = p_provider AND f.form_id = p_form_id AND f.enabled AND c.status = 'active'
$$;

CREATE FUNCTION rc_lead_ingest(p_source text, p_provider_lead_id text, p_form uuid, p_name text, p_phone text, p_email text,
                               p_problem text, p_answers jsonb, p_campaign jsonb, p_whatsapp_opt_in boolean, p_simulated boolean)
RETURNS TABLE (lead_id uuid, patient_id uuid, new_patient boolean, duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pid uuid; lid uuid; created boolean := false; existing uuid;
BEGIN
  IF rc_clinic_id() IS NULL THEN RAISE EXCEPTION 'no clinic in context'; END IF;
  SELECT id INTO existing FROM leads WHERE source = p_source AND provider_lead_id = p_provider_lead_id;
  IF existing IS NOT NULL THEN
    RETURN QUERY SELECT existing, (SELECT l.patient_id FROM leads l WHERE l.id = existing), false, true; RETURN;
  END IF;
  IF coalesce(length(rc_phone_digits(p_phone)), 0) >= 10 THEN
    SELECT p.id INTO pid FROM patients p
     WHERE p.clinic_id = rc_clinic_id() AND p.merged_into IS NULL AND right(rc_phone_digits(p.phone), 10) = right(rc_phone_digits(p_phone), 10)
     ORDER BY p.registered_at LIMIT 1;
  END IF;
  IF pid IS NULL THEN
    INSERT INTO patients (clinic_id, name, phone, email, first_problem)
    VALUES (rc_clinic_id(), left(p_name, 120), nullif(p_phone, ''), nullif(p_email, ''), nullif(left(p_problem, 300), '')) RETURNING id INTO pid;
    created := true;
  END IF;
  IF p_whatsapp_opt_in THEN
    UPDATE patients SET whatsapp_status = 'opted_in', whatsapp_status_at = now(), whatsapp_status_by = 'lead_form'
     WHERE id = pid AND whatsapp_status = 'unknown';
  END IF;
  INSERT INTO leads (clinic_id, source, provider_lead_id, form_id, patient_id, name, phone, email, answers, campaign, status, is_simulated)
  VALUES (rc_clinic_id(), p_source, p_provider_lead_id, p_form, pid, left(p_name, 120), p_phone, p_email, p_answers, p_campaign,
          'new', p_simulated)
  RETURNING id INTO lid;
  INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail)
  VALUES (rc_clinic_id(), NULL, false, 'lead_received', 'lead', lid::text, jsonb_build_object('source', p_source, 'new_patient', created));
  RETURN QUERY SELECT lid, pid, created, false;
END $$;
REVOKE ALL ON FUNCTION rc_lead_form_clinic(text, text), rc_lead_ingest(text, text, uuid, text, text, text, text, jsonb, jsonb, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_lead_form_clinic(text, text), rc_lead_ingest(text, text, uuid, text, text, text, text, jsonb, jsonb, boolean, boolean) TO rc_app;

-- ---------- workflow event: lead received ----------
CREATE OR REPLACE FUNCTION rc_wf_candidates(p_event text, p_months int, p_weeks int, p_lookback interval)
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
  ELSIF p_event = 'lead_received' THEN
    RETURN QUERY SELECT 'lead:' || l.id::text, l.patient_id, NULL::uuid, NULL::uuid, l.created_at, NULL::text, l.is_simulated FROM leads l
      WHERE l.clinic_id = rc_clinic_id() AND l.patient_id IS NOT NULL AND l.status = 'new' AND l.created_at > now() - p_lookback;
  END IF;
END $$;

-- ---------- review request link tracking ----------
ALTER TABLE whatsapp_messages ADD COLUMN link_token text UNIQUE, ADD COLUMN link_clicked_at timestamptz;

-- public redirect: the token is random and only says "this link was opened"; returns the clinic's review link
CREATE FUNCTION rc_review_click(p_token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE url text;
BEGIN
  IF p_token !~ '^[A-Za-z0-9_-]{16,64}$' THEN RETURN NULL; END IF;
  UPDATE whatsapp_messages m SET link_clicked_at = coalesce(m.link_clicked_at, now())
   WHERE m.link_token = p_token RETURNING (SELECT w.review_url FROM clinic_whatsapp w WHERE w.clinic_id = m.clinic_id) INTO url;
  RETURN url;
END $$;
REVOKE ALL ON FUNCTION rc_review_click(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_review_click(text) TO rc_app;

-- ---------- packs: lead follow-up and review requests (installed switched off) ----------
WITH lp AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes, install_enabled)
  VALUES ('leads', 'all', 'Lead ads follow-up', 1, true, 'draft', 2, 'Calls (and, with opt-in, messages) people who fill in the clinic''s Meta lead form.', false) RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT lp.id, t.key, t.name, t.description, t.steps::jsonb FROM lp, (VALUES
 ('lead_followup', 'Follow up lead-ad enquiries',
  'When someone fills in the clinic''s Facebook or Instagram lead form: a WhatsApp welcome (if they agreed), a NEPA call within 5 minutes, another the next day if not booked, then staff are told.',
  '{"trigger":{"event":"lead_received"},"steps":[
     {"key":"welcome","afterMinutes":0,"action":"whatsapp","template":"lead_welcome","onlyIf":"no_upcoming"},
     {"key":"call","afterMinutes":5,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"call_again","afterMinutes":1440,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":2880,"action":"attention","reason":"Lead-ad enquiry has not booked after two calls.","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

WITH rp AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes, install_enabled)
  VALUES ('reviews', 'all', 'Google review requests', 1, true, 'draft', 2, 'Asks every patient alike after a visit; needs WhatsApp and a review link.', false) RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT rp.id, t.key, t.name, t.description, t.steps::jsonb FROM rp, (VALUES
 ('review_request', 'Ask for a Google review',
  'Three hours after a visit is marked done, sends a WhatsApp message with the clinic''s Google review link. At most once in six months per patient.',
  '{"trigger":{"event":"appointment_completed"},"steps":[
     {"key":"ask","afterMinutes":180,"action":"whatsapp","template":"review_request","onlyIf":"always"}]}')
) AS t(key, name, description, steps);

SELECT rc_install_pack(id) FROM clinics;

-- ---------- Results: V2 numbers (same rules as rc_results: view_results needed, simulated excluded by default) ----------
CREATE FUNCTION rc_results_v2(p_from timestamptz, p_to timestamptz, p_include_simulated boolean DEFAULT false)
RETURNS TABLE (metric text, value numeric)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT (rc_is_super() OR rc_has_capability('view_results')) THEN RAISE EXCEPTION 'view_results permission required'; END IF;
  RETURN QUERY
  WITH m AS (SELECT * FROM whatsapp_messages WHERE clinic_id = rc_clinic_id() AND created_at >= p_from AND created_at < p_to AND (p_include_simulated OR NOT is_simulated)),
       l AS (SELECT * FROM leads WHERE clinic_id = rc_clinic_id() AND created_at >= p_from AND created_at < p_to AND (p_include_simulated OR NOT is_simulated))
  SELECT 'whatsapp_sent', count(*)::numeric FROM m WHERE direction = 'out' AND status IN ('sent','delivered','read')
  UNION ALL SELECT 'whatsapp_replies', count(*)::numeric FROM m WHERE direction = 'in'
  UNION ALL SELECT 'confirmed_on_whatsapp', count(*)::numeric FROM audit_log a
     WHERE a.clinic_id = rc_clinic_id() AND a.action = 'appointment_confirmed_by_whatsapp' AND a.created_at >= p_from AND a.created_at < p_to
  UNION ALL SELECT 'leads_received', count(*)::numeric FROM l
  UNION ALL SELECT 'leads_booked', count(*)::numeric FROM l
     WHERE EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id = l.patient_id AND a.created_at >= l.created_at AND a.status <> 'cancelled')
  UNION ALL SELECT 'review_requests_sent', count(*)::numeric FROM m WHERE template_key = 'review_request' AND status IN ('sent','delivered','read')
  UNION ALL SELECT 'review_links_opened', count(*)::numeric FROM m WHERE template_key = 'review_request' AND link_clicked_at IS NOT NULL;
END $$;
GRANT EXECUTE ON FUNCTION rc_results_v2(timestamptz, timestamptz, boolean) TO rc_app;
