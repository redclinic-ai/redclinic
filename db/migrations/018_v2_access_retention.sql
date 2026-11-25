-- 018 (V2): clinic data policy (restricted super admin access, retention rules).
-- 1. Each clinic chooses whether RedClinic staff (super admin) can open its patient data at any time ('full', the V1
--    behaviour and the default) or only with an access grant the clinic approves ('request').
--    Patient-data policies now let a super admin in only (a) for the clinic in the request context and (b) when
--    rc_super_patient_access() says so. Business tables (clinics, plans, invoices, users, settings) are unchanged.
-- 2. Retention: per-clinic days to keep call recordings, transcripts, assistant logs and telephony events
--    (NULL = keep; V1 collected everything). Patient records, appointments, documents and consent are never purged here.

CREATE TABLE clinic_data_policy (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  super_access text NOT NULL DEFAULT 'full' CHECK (super_access IN ('full','request')),
  recording_days int CHECK (recording_days BETWEEN 7 AND 3650),
  transcript_days int CHECK (transcript_days BETWEEN 7 AND 3650),
  assistant_log_days int CHECK (assistant_log_days BETWEEN 7 AND 3650),
  telephony_event_days int CHECK (telephony_event_days BETWEEN 7 AND 3650),
  last_purge_at timestamptz,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Readable by RedClinic and the clinic; changed only by the clinic itself (RedClinic must not loosen its own access).
ALTER TABLE clinic_data_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY dp_read ON clinic_data_policy FOR SELECT
  USING ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings'))));
CREATE POLICY dp_write ON clinic_data_policy FOR ALL
  USING (NOT (SELECT rc_is_super()) AND clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings')))
  WITH CHECK (NOT (SELECT rc_is_super()) AND clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings')));
GRANT SELECT, INSERT, UPDATE ON clinic_data_policy TO rc_app;

CREATE TABLE super_access_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  hours int NOT NULL CHECK (hours BETWEEN 1 AND 168),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','denied','revoked')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX super_access_grants_clinic ON super_access_grants (clinic_id, created_at DESC);
ALTER TABLE super_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY g_read ON super_access_grants FOR SELECT
  USING ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings'))));
CREATE POLICY g_request ON super_access_grants FOR INSERT
  WITH CHECK ((SELECT rc_is_super()) AND status = 'requested' AND requested_by = (SELECT rc_user_id()));
CREATE POLICY g_decide ON super_access_grants FOR UPDATE
  USING (NOT (SELECT rc_is_super()) AND clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings')))
  WITH CHECK (NOT (SELECT rc_is_super()) AND clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings')));
GRANT SELECT, INSERT, UPDATE ON super_access_grants TO rc_app;

-- True when the super admin may read the request-context clinic's patient data now.
CREATE FUNCTION rc_super_patient_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rc_is_super() AND rc_clinic_id() IS NOT NULL AND (
    coalesce((SELECT super_access FROM clinic_data_policy WHERE clinic_id = rc_clinic_id()), 'full') = 'full'
    OR EXISTS (SELECT 1 FROM super_access_grants g WHERE g.clinic_id = rc_clinic_id() AND g.status = 'approved' AND g.expires_at > now()))
$$;
REVOKE ALL ON FUNCTION rc_super_patient_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_super_patient_access() TO rc_app;

-- Patient-data tables: replace the blanket super admin bypass with the clinic-scoped, policy-checked one.
CREATE TABLE patient_data_tables (table_name text PRIMARY KEY);
INSERT INTO patient_data_tables VALUES ('patients'),('patient_clinical'),('patient_consents'),('appointments'),('calls'),
  ('call_transcripts'),('telephony_events'),('documents'),('approvals'),('assistant_interactions'),('attention_items'),
  ('outbound_queue'),('workflow_runs');
REVOKE ALL ON patient_data_tables FROM PUBLIC;

CREATE FUNCTION rc_restrict_super_on(p_table text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pol record; q text; w text; cmd text; roles text;
  old CONSTANT text := '( SELECT rc_is_super() AS rc_is_super)';
  new CONSTANT text := '(( SELECT rc_super_patient_access() AS rc_super_patient_access) AND (clinic_id = ( SELECT rc_clinic_id() AS rc_clinic_id)))';
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE schemaname = 'public' AND tablename = p_table LOOP
    -- "super OR (member branch)" -> "(scoped super access) OR (NOT super AND member branch)": rc_has_capability()
    -- answers true for a super admin, so the member branch must not let one in through the back door.
    q := replace(replace(replace(pol.qual, old || ' OR (', new || ' OR ((NOT @SUPER@) AND '), old, new), '@SUPER@', old);
    w := replace(replace(replace(pol.with_check, old || ' OR (', new || ' OR ((NOT @SUPER@) AND '), old, new), '@SUPER@', old);
    IF q IS NOT DISTINCT FROM pol.qual AND w IS NOT DISTINCT FROM pol.with_check THEN CONTINUE; END IF;
    roles := array_to_string(ARRAY(SELECT quote_ident(r) FROM unnest(pol.roles) r), ', ');
    EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, p_table);
    cmd := format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s', pol.policyname, p_table, pol.permissive, pol.cmd, roles);
    IF q IS NOT NULL THEN cmd := cmd || ' USING (' || q || ')'; END IF;
    IF w IS NOT NULL THEN cmd := cmd || ' WITH CHECK (' || w || ')'; END IF;
    EXECUTE cmd;
  END LOOP;
END $$;
SELECT rc_restrict_super_on(table_name) FROM patient_data_tables;

-- New V2 patient-data tables use this instead of rc_enable_tenant_rls.
CREATE FUNCTION rc_enable_patient_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO patient_data_tables VALUES (p_table::text) ON CONFLICT DO NOTHING;
  PERFORM rc_enable_tenant_rls(p_table);
  PERFORM rc_restrict_super_on(p_table::text);
END $$;

DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies p JOIN patient_data_tables t ON t.table_name = p.tablename
   WHERE (coalesce(p.qual,'') || coalesce(p.with_check,'')) ~ '(?<!NOT )\( SELECT rc_is_super\(\) AS rc_is_super\)';
  IF n > 0 THEN RAISE EXCEPTION '% patient-data policies still give the super admin a blanket bypass', n; END IF;
END $$;

-- Retention: deletes expired transcripts, assistant logs and telephony events, returns how many per kind.
-- Recordings are files: rc_expired_recordings lists them; the app deletes the file, then rc_mark_recording_deleted.
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_recording_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_recording_status_check
  CHECK (recording_status IN ('none','recording','stored','failed','not_permitted','caller_objected','deleted'));

CREATE FUNCTION rc_apply_retention(p_clinic uuid, p_recordings int DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p clinic_data_policy; t int := 0; a int := 0; e int := 0;
BEGIN
  SELECT * INTO p FROM clinic_data_policy WHERE clinic_id = p_clinic;
  IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
  IF p.transcript_days IS NOT NULL THEN
    DELETE FROM call_transcripts ct USING calls c
     WHERE ct.call_id = c.id AND c.clinic_id = p_clinic AND c.started_at < now() - make_interval(days => p.transcript_days);
    GET DIAGNOSTICS t = ROW_COUNT;
  END IF;
  IF p.assistant_log_days IS NOT NULL THEN
    DELETE FROM assistant_interactions WHERE clinic_id = p_clinic AND created_at < now() - make_interval(days => p.assistant_log_days);
    GET DIAGNOSTICS a = ROW_COUNT;
  END IF;
  IF p.telephony_event_days IS NOT NULL THEN
    DELETE FROM telephony_events WHERE clinic_id = p_clinic AND received_at < now() - make_interval(days => p.telephony_event_days);
    GET DIAGNOSTICS e = ROW_COUNT;
  END IF;
  UPDATE clinic_data_policy SET last_purge_at = now() WHERE clinic_id = p_clinic;
  IF t + a + e + p_recordings > 0 THEN
    INSERT INTO audit_log (clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail)
    VALUES (p_clinic, NULL, false, 'retention_purge', 'clinic', p_clinic::text, jsonb_build_object('recordings', p_recordings, 'transcript_lines', t, 'assistant_logs', a, 'telephony_events', e));
  END IF;
  RETURN jsonb_build_object('transcript_lines', t, 'assistant_logs', a, 'telephony_events', e);
END $$;

CREATE FUNCTION rc_expired_recordings(p_clinic uuid, p_limit int DEFAULT 200) RETURNS TABLE (call_id uuid, recording_ref text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.recording_ref FROM calls c JOIN clinic_data_policy p ON p.clinic_id = c.clinic_id
   WHERE c.clinic_id = p_clinic AND p.recording_days IS NOT NULL AND c.recording_ref IS NOT NULL
     AND c.started_at < now() - make_interval(days => p.recording_days)
   ORDER BY c.started_at LIMIT p_limit
$$;

CREATE FUNCTION rc_mark_recording_deleted(p_call uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE calls SET recording_ref = NULL, recording_status = 'deleted' WHERE id = p_call
$$;

-- Clinics whose purge is due (at most once every 6 hours).
CREATE FUNCTION rc_retention_due() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT clinic_id FROM clinic_data_policy
   WHERE (recording_days IS NOT NULL OR transcript_days IS NOT NULL OR assistant_log_days IS NOT NULL OR telephony_event_days IS NOT NULL)
     AND (last_purge_at IS NULL OR last_purge_at < now() - interval '6 hours')
$$;
REVOKE ALL ON FUNCTION rc_apply_retention(uuid, int), rc_expired_recordings(uuid, int), rc_mark_recording_deleted(uuid), rc_retention_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_apply_retention(uuid, int), rc_expired_recordings(uuid, int), rc_mark_recording_deleted(uuid), rc_retention_due() TO rc_app;

-- Counts for the super admin clinic page: numbers only, no patient data, so they work in "request" mode too.
CREATE FUNCTION rc_admin_clinic_counts(p_clinic uuid) RETURNS TABLE (calls int, appointments int, transcript_lines int, patients int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT rc_is_super() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT
    (SELECT count(*) FROM calls WHERE clinic_id = p_clinic AND NOT is_simulated)::int,
    (SELECT count(*) FROM appointments WHERE clinic_id = p_clinic)::int,
    (SELECT count(*) FROM call_transcripts WHERE clinic_id = p_clinic)::int,
    (SELECT count(*) FROM patients WHERE clinic_id = p_clinic AND merged_into IS NULL)::int;
END $$;
REVOKE ALL ON FUNCTION rc_admin_clinic_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_admin_clinic_counts(uuid) TO rc_app;

-- Billing notices go on a clinic's "Needs attention" list from RedClinic's billing job, which has no clinic context
-- and must not need patient-data access to do it.
CREATE FUNCTION rc_add_billing_attention(p_clinic uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT rc_is_super() THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  INSERT INTO attention_items (clinic_id, kind, reason, urgency) VALUES (p_clinic, 'billing', p_reason, 2) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION rc_add_billing_attention(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_add_billing_attention(uuid, text) TO rc_app;
