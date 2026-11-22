-- 001: core tenancy, users, capabilities, audit. Run as the owner role.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rc_app') THEN
    CREATE ROLE rc_app NOLOGIN;
  END IF;
END $$;

-- ---------- request context (set by the application after authentication) ----------
CREATE FUNCTION rc_set_context(p_user uuid, p_clinic uuid, p_super boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.user_id',  COALESCE(p_user::text, ''), true);
  PERFORM set_config('app.clinic_id', COALESCE(p_clinic::text, ''), true);
  PERFORM set_config('app.is_super_admin', CASE WHEN p_super THEN 'true' ELSE 'false' END, true);
END $$;

CREATE FUNCTION rc_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION rc_clinic_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.clinic_id', true), '')::uuid $$;
CREATE FUNCTION rc_is_super() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.is_super_admin', true), 'false') = 'true' $$;

-- ---------- clinics ----------
CREATE TABLE clinics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  clinic_type text NOT NULL DEFAULT 'dental',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  city text,
  phone text,
  working_hours jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION rc_clinic_active(p_clinic uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM clinics WHERE id = p_clinic AND status = 'active') $$;

-- ---------- users ----------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid REFERENCES clinics(id),
  role text NOT NULL CHECK (role IN ('super_admin','clinic_admin','doctor','receptionist','clinic_manager')),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'super_admin' AND clinic_id IS NULL) OR (role <> 'super_admin' AND clinic_id IS NOT NULL))
);

-- ---------- capabilities ----------
CREATE TABLE capabilities (code text PRIMARY KEY, description text NOT NULL);
INSERT INTO capabilities VALUES
 ('view_patients','See the patient list and basic details'),
 ('edit_patient','Create and edit patients'),
 ('view_patient_history','See medical history, allergies and clinical notes'),
 ('upload_document','Upload documents'),
 ('view_documents','Open documents'),
 ('manage_appointments','Book, move and cancel appointments'),
 ('view_calls','See call records'),
 ('view_call_transcripts','Read call transcripts'),
 ('edit_workflow','Edit workflows and scripts'),
 ('approve_actions','Approve or reject NEPA actions'),
 ('view_approvals','See the approval queue'),
 ('manage_attention','Work the Needs attention list'),
 ('view_results','See the results dashboard'),
 ('export_data','Export data'),
 ('manage_staff','Invite staff and change permissions'),
 ('view_audit_log','See the audit log'),
 ('manage_billing','See and change the plan');

CREATE TABLE role_presets (
  role text NOT NULL CHECK (role IN ('doctor','receptionist','clinic_manager')),
  capability text NOT NULL REFERENCES capabilities(code),
  PRIMARY KEY (role, capability)
);
INSERT INTO role_presets VALUES
 ('doctor','view_patients'),('doctor','edit_patient'),('doctor','view_patient_history'),
 ('doctor','upload_document'),('doctor','view_documents'),('doctor','manage_appointments'),
 ('doctor','view_calls'),('doctor','view_call_transcripts'),
 ('receptionist','view_patients'),('receptionist','edit_patient'),('receptionist','upload_document'),
 ('receptionist','manage_appointments'),('receptionist','view_calls'),('receptionist','manage_attention'),
 ('clinic_manager','view_patients'),('clinic_manager','manage_appointments'),('clinic_manager','view_calls'),
 ('clinic_manager','manage_attention'),('clinic_manager','view_approvals'),('clinic_manager','view_results');

CREATE TABLE staff_capabilities (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  capability text NOT NULL REFERENCES capabilities(code),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability)
);

-- Platform feature switches per clinic (super admin). Caps what a clinic admin may grant.
CREATE TABLE clinic_features (
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  feature text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (clinic_id, feature)
);

CREATE FUNCTION rc_apply_role_preset(p_user uuid, p_granted_by uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO staff_capabilities (user_id, clinic_id, capability, granted_by)
  SELECT u.id, u.clinic_id, rp.capability, p_granted_by
  FROM users u JOIN role_presets rp ON rp.role = u.role WHERE u.id = p_user
  ON CONFLICT DO NOTHING
$$;

CREATE FUNCTION rc_has_capability(p_cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rc_is_super() OR EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = rc_user_id() AND u.status = 'active' AND u.clinic_id = rc_clinic_id()
      AND rc_clinic_active(u.clinic_id)
      AND (u.role = 'clinic_admin'
           OR EXISTS (SELECT 1 FROM staff_capabilities sc WHERE sc.user_id = u.id AND sc.capability = p_cap))
  )
$$;

-- ---------- terms and audit ----------
CREATE TABLE terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  user_id uuid NOT NULL REFERENCES users(id),
  terms_version text NOT NULL,
  wording text NOT NULL,
  ip text,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  clinic_id uuid REFERENCES clinics(id),
  actor_user_id uuid REFERENCES users(id),
  actor_is_super boolean NOT NULL DEFAULT false,
  action text NOT NULL,
  entity text,
  entity_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION rc_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION rc_audit_immutable();

-- ---------- tenant RLS helper ----------
-- Every clinic-owned table gets: super admin sees all; clinic staff see their own active clinic only.
CREATE FUNCTION rc_enable_tenant_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY tenant ON %s
    USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)))
    WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)))$p$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO rc_app', p_table);
END $$;

-- clinics: staff see only their own clinic; only super admin may create or change clinics
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
CREATE POLICY clinics_read ON clinics FOR SELECT
  USING (rc_is_super() OR id = rc_clinic_id());
CREATE POLICY clinics_write ON clinics FOR ALL
  USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE ON clinics TO rc_app;

-- users: clinic admins manage staff; staff can read colleagues; super admin rows are hidden from clinics
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY users_write ON users FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND role <> 'super_admin' AND rc_has_capability('manage_staff')));
GRANT SELECT, INSERT, UPDATE ON users TO rc_app;

-- staff_capabilities: only readable in own clinic; changed only with manage_staff
ALTER TABLE staff_capabilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY sc_read ON staff_capabilities FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY sc_write ON staff_capabilities FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff')));
GRANT SELECT, INSERT, DELETE ON staff_capabilities TO rc_app;

-- clinic_features: clinics read their own; only super admin writes
ALTER TABLE clinic_features ENABLE ROW LEVEL SECURITY;
CREATE POLICY cf_read ON clinic_features FOR SELECT
  USING (rc_is_super() OR clinic_id = rc_clinic_id());
CREATE POLICY cf_write ON clinic_features FOR ALL
  USING (rc_is_super()) WITH CHECK (rc_is_super());
GRANT SELECT, INSERT, UPDATE, DELETE ON clinic_features TO rc_app;

SELECT rc_enable_tenant_rls('terms_acceptances');
GRANT SELECT ON capabilities, role_presets TO rc_app;

-- audit_log: clinic admins with view_audit_log read their own clinic; anyone may append for their own clinic
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('view_audit_log')));
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (rc_is_super() OR clinic_id = rc_clinic_id());
GRANT SELECT, INSERT ON audit_log TO rc_app;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO rc_app;
