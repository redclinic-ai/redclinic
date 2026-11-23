-- 017: Phase 8 performance.
-- 1. Row-level security policies called rc_is_super(), rc_clinic_id(), rc_has_capability(...) and
--    rc_clinic_active(clinic_id) once per row. Wrapping each call in a scalar sub-select makes PostgreSQL evaluate it
--    once per query (an InitPlan). Meaning is unchanged: the functions are STABLE and take no row values, and
--    rc_clinic_active(clinic_id) only ever appears next to "clinic_id = rc_clinic_id()", so it becomes
--    rc_clinic_active(rc_clinic_id()). Every policy is rewritten mechanically from its own definition.
-- 2. Indexes for patient search (phone substring, code; the name trigram index exists since 002) and appointment day lists.

DO $$
DECLARE pol record; q text; w text; cmd text; roles text;
  FUNCTION_CALLS CONSTANT text[] := ARRAY['rc_is_super()', 'rc_clinic_id()', 'rc_user_id()'];
  f text;
BEGIN
  FOR pol IN SELECT * FROM pg_policies WHERE schemaname = 'public' LOOP
    q := pol.qual; w := pol.with_check;
    -- capability checks: rc_has_capability('x'::text) -> (SELECT rc_has_capability('x'::text))
    q := regexp_replace(q, '(?<!SELECT )rc_has_capability\(([^()]*)\)', '(SELECT rc_has_capability(\1))', 'g');
    w := regexp_replace(w, '(?<!SELECT )rc_has_capability\(([^()]*)\)', '(SELECT rc_has_capability(\1))', 'g');
    q := replace(q, 'rc_clinic_active(clinic_id)', '(SELECT rc_clinic_active(rc_clinic_id()))');
    w := replace(w, 'rc_clinic_active(clinic_id)', '(SELECT rc_clinic_active(rc_clinic_id()))');
    FOREACH f IN ARRAY FUNCTION_CALLS LOOP
      -- leave calls already inside a sub-select (or inside rc_clinic_active(...)) alone
      q := regexp_replace(q, '(?<!SELECT |rc_clinic_active\()' || replace(replace(f, '(', '\('), ')', '\)'), '(SELECT ' || f || ')', 'g');
      w := regexp_replace(w, '(?<!SELECT |rc_clinic_active\()' || replace(replace(f, '(', '\('), ')', '\)'), '(SELECT ' || f || ')', 'g');
    END LOOP;
    IF q IS NOT DISTINCT FROM pol.qual AND w IS NOT DISTINCT FROM pol.with_check THEN CONTINUE; END IF;
    roles := array_to_string(ARRAY(SELECT quote_ident(r) FROM unnest(pol.roles) r), ', ');
    EXECUTE format('DROP POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    cmd := format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s', pol.policyname, pol.schemaname, pol.tablename, pol.permissive, pol.cmd, roles);
    IF q IS NOT NULL THEN cmd := cmd || ' USING (' || q || ')'; END IF;
    IF w IS NOT NULL THEN cmd := cmd || ' WITH CHECK (' || w || ')'; END IF;
    EXECUTE cmd;
  END LOOP;
END $$;

-- no policy may still call these functions per row
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public'
    AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~ '(?<!SELECT |rc_clinic_active\()rc_(is_super|clinic_id|has_capability|user_id)\(';
  IF n > 0 THEN RAISE EXCEPTION '% policies still evaluate per row', n; END IF;
END $$;

CREATE INDEX patients_phone_trgm ON patients USING gin (rc_phone_digits(phone) gin_trgm_ops);
CREATE INDEX patients_code_upper ON patients (upper(patient_code));
CREATE INDEX appointments_clinic_start ON appointments (clinic_id, starts_at);
CREATE INDEX calls_clinic_started_desc ON calls (clinic_id, started_at DESC);
CREATE INDEX audit_log_clinic_id ON audit_log (clinic_id, id DESC);

-- policy helpers for future tables use the once-per-query form too (house rule: DECISIONS D25)
CREATE OR REPLACE FUNCTION rc_enable_tenant_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY tenant ON %s
    USING ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_clinic_active(rc_clinic_id()))))
    WITH CHECK ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_clinic_active(rc_clinic_id()))))$p$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO rc_app', p_table);
END $$;
CREATE OR REPLACE FUNCTION rc_enable_settings_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY s_read ON %s FOR SELECT
    USING ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_clinic_active(rc_clinic_id()))))$p$, p_table);
  EXECUTE format($p$CREATE POLICY s_write ON %s FOR ALL
    USING ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings'))))
    WITH CHECK ((SELECT rc_is_super()) OR (clinic_id = (SELECT rc_clinic_id()) AND (SELECT rc_has_capability('manage_settings'))))$p$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO rc_app', p_table);
END $$;

CREATE INDEX patients_merged_into ON patients (merged_into) WHERE merged_into IS NOT NULL;
