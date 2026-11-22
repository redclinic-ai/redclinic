-- 010: Phase 2, clinic application. Clinic profile and settings, services, FAQs, consent wording,
-- patient duplicate detection and controlled merge, walk-ins, new capabilities.

-- ---------- capabilities ----------
INSERT INTO capabilities VALUES
 ('manage_settings', 'Change clinic profile, services, FAQs and consent wording'),
 ('merge_patients',  'Merge duplicate patient records'),
 ('import_patients', 'Import patients from a CSV file'),
 ('record_consent',  'Record or withdraw patient consent');
INSERT INTO role_presets VALUES
 ('receptionist','record_consent'), ('doctor','record_consent'), ('clinic_manager','record_consent');
-- existing staff get the new preset capability
INSERT INTO staff_capabilities (user_id, clinic_id, capability)
SELECT u.id, u.clinic_id, 'record_consent' FROM users u WHERE u.role IN ('receptionist','doctor','clinic_manager')
ON CONFLICT DO NOTHING;

-- ---------- clinic profile ----------
ALTER TABLE clinics
  ADD COLUMN address text,
  ADD COLUMN email text,
  ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN languages text[] NOT NULL DEFAULT ARRAY['en','hi','kn'],
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';   -- small clinic-level options (e.g. default appointment length)

-- Clinic staff may not write the clinics table directly (only the super admin may), so the profile is changed
-- through this function, which checks manage_settings and only touches profile fields (never status or type).
CREATE FUNCTION rc_update_clinic_profile(p_name text, p_address text, p_city text, p_phone text, p_email text,
  p_timezone text, p_languages text[], p_working_hours jsonb, p_settings jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF rc_clinic_id() IS NULL OR NOT rc_has_capability('manage_settings') THEN
    RAISE EXCEPTION 'manage_settings permission required';
  END IF;
  UPDATE clinics SET name = p_name, address = p_address, city = p_city, phone = p_phone, email = p_email,
    timezone = p_timezone, languages = p_languages, working_hours = p_working_hours, settings = p_settings
  WHERE id = rc_clinic_id();
  INSERT INTO audit_log (clinic_id, actor_user_id, action, entity, entity_id)
  VALUES (rc_clinic_id(), rc_user_id(), 'clinic_profile_updated', 'clinic', rc_clinic_id()::text);
END $$;
REVOKE ALL ON FUNCTION rc_update_clinic_profile(text,text,text,text,text,text,text[],jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_update_clinic_profile(text,text,text,text,text,text,text[],jsonb,jsonb) TO rc_app;

-- helper for settings tables: everyone in the clinic reads; manage_settings writes
CREATE FUNCTION rc_enable_settings_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY s_read ON %s FOR SELECT
    USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)))$p$, p_table);
  EXECUTE format($p$CREATE POLICY s_write ON %s FOR ALL
    USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_settings')))
    WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_settings')))$p$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO rc_app', p_table);
END $$;

-- ---------- services (what the clinic offers; used for booking length and by NEPA). No prices (D5). ----------
CREATE TABLE clinic_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  name text NOT NULL,
  duration_minutes int NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 5 AND 480),
  description text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, name)
);
SELECT rc_enable_settings_rls('clinic_services');

-- ---------- FAQs (the only answers NEPA may give about the clinic) ----------
CREATE TABLE clinic_faqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  question text NOT NULL,
  answer text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_settings_rls('clinic_faqs');

-- ---------- consent wording (editable, versioned; English and Hindi defaults come from the app) ----------
CREATE TABLE consent_wordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  language text NOT NULL CHECK (language IN ('en','hi')),
  version int NOT NULL,
  wording text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, language, version)
);
SELECT rc_enable_settings_rls('consent_wordings');
REVOKE UPDATE, DELETE ON consent_wordings FROM rc_app;   -- versions are kept, never edited

-- consent records now need record_consent (was any clinic member)
DROP POLICY tenant ON patient_consents;
CREATE POLICY pcons_read ON patient_consents FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY pcons_insert ON patient_consents FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('record_consent')));
REVOKE UPDATE, DELETE ON patient_consents FROM rc_app;   -- history is append-only
ALTER TABLE patient_consents ADD COLUMN note text;

-- ---------- appointments ----------
ALTER TABLE appointments DROP CONSTRAINT appointments_booked_via_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_booked_via_check
  CHECK (booked_via IN ('staff','nepa','import','walk_in'));
ALTER TABLE appointments
  ADD COLUMN service_id uuid REFERENCES clinic_services(id),
  ADD COLUMN cancel_reason text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rescheduled_from uuid REFERENCES appointments(id);
SELECT rc_add_same_clinic('appointments','service_id','clinic_services');
CREATE INDEX appointments_patient ON appointments (patient_id, starts_at DESC);

-- ---------- patients: duplicates and merge ----------
CREATE FUNCTION rc_phone_digits(p text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT right(regexp_replace(coalesce(p,''), '\D', '', 'g'), 10) $$;
CREATE INDEX patients_phone_digits ON patients (clinic_id, rc_phone_digits(phone));

-- Possible duplicates of a new or existing patient, within the caller's clinic (row-level security applies:
-- this function is SECURITY INVOKER). Same phone (last 10 digits), or a very similar name with the same
-- date of birth / age.
CREATE FUNCTION rc_find_duplicates(p_name text, p_phone text, p_dob date, p_age int, p_exclude uuid DEFAULT NULL)
RETURNS TABLE (patient_id uuid, patient_code text, name text, phone text, reason text)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.patient_code, p.name, p.phone,
         CASE WHEN length(rc_phone_digits(p_phone)) = 10 AND rc_phone_digits(p.phone) = rc_phone_digits(p_phone)
              THEN 'same phone' ELSE 'similar name' END
  FROM patients p
  WHERE p.merged_into IS NULL AND (p_exclude IS NULL OR p.id <> p_exclude)
    AND (
      (length(rc_phone_digits(p_phone)) = 10 AND rc_phone_digits(p.phone) = rc_phone_digits(p_phone))
      OR (similarity(lower(p.name), lower(p_name)) > 0.6
          AND ((p_dob IS NOT NULL AND p.date_of_birth = p_dob) OR (p_age IS NOT NULL AND p.age_years = p_age)
               OR (p_dob IS NULL AND p_age IS NULL)))
    )
  ORDER BY 5, p.registered_at
  LIMIT 10
$$;
GRANT EXECUTE ON FUNCTION rc_find_duplicates(text, text, date, int, uuid) TO rc_app;

-- Controlled merge: everything of p_from moves to p_keep, p_from is kept (never deleted) and marked merged.
-- Patient codes stay permanent; the merged code still finds the kept patient.
CREATE FUNCTION rc_merge_patients(p_keep uuid, p_from uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k patients%ROWTYPE; f patients%ROWTYPE; kc patient_clinical%ROWTYPE; fc patient_clinical%ROWTYPE;
BEGIN
  IF NOT rc_has_capability('merge_patients') THEN RAISE EXCEPTION 'merge_patients permission required'; END IF;
  SELECT * INTO k FROM patients WHERE id = p_keep FOR UPDATE;
  SELECT * INTO f FROM patients WHERE id = p_from FOR UPDATE;
  IF k.id IS NULL OR f.id IS NULL OR k.clinic_id <> rc_clinic_id() OR f.clinic_id <> rc_clinic_id() THEN
    RAISE EXCEPTION 'patients not found';
  END IF;
  IF p_keep = p_from OR k.merged_into IS NOT NULL OR f.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'these patients cannot be merged';
  END IF;
  UPDATE appointments SET patient_id = p_keep WHERE patient_id = p_from;
  UPDATE documents SET patient_id = p_keep WHERE patient_id = p_from;
  UPDATE calls SET patient_id = p_keep WHERE patient_id = p_from;
  UPDATE patient_consents SET patient_id = p_keep WHERE patient_id = p_from;
  UPDATE attention_items SET patient_id = p_keep WHERE patient_id = p_from;
  -- clinical notes: keep both texts, never lose one
  SELECT * INTO fc FROM patient_clinical WHERE patient_id = p_from;
  IF fc.patient_id IS NOT NULL THEN
    SELECT * INTO kc FROM patient_clinical WHERE patient_id = p_keep;
    IF kc.patient_id IS NULL THEN
      INSERT INTO patient_clinical (patient_id, clinic_id, medical_history, allergies, notes)
      VALUES (p_keep, k.clinic_id, fc.medical_history, fc.allergies, fc.notes);
    ELSE
      UPDATE patient_clinical SET
        medical_history = concat_ws(E'\n', kc.medical_history, nullif(fc.medical_history, '')),
        allergies = concat_ws(E'\n', kc.allergies, nullif(fc.allergies, '')),
        notes = concat_ws(E'\n', kc.notes, CASE WHEN coalesce(fc.notes,'') <> '' THEN '[from ' || f.patient_code || '] ' || fc.notes END),
        updated_at = now()
      WHERE patient_id = p_keep;
    END IF;
  END IF;
  -- fill gaps on the kept record from the merged one
  UPDATE patients SET
    phone = coalesce(phone, f.phone), email = coalesce(email, f.email),
    date_of_birth = coalesce(date_of_birth, f.date_of_birth), age_years = coalesce(age_years, f.age_years),
    gender = coalesce(gender, f.gender), address = coalesce(address, f.address),
    assigned_doctor_id = coalesce(assigned_doctor_id, f.assigned_doctor_id),
    registered_at = least(registered_at, f.registered_at)
  WHERE id = p_keep;
  UPDATE patients SET merged_into = p_keep WHERE id = p_from;
  -- consent: the latest record across both now belongs to the kept patient
  UPDATE patients SET consent_status = coalesce(
    (SELECT status FROM patient_consents WHERE patient_id = p_keep ORDER BY recorded_at DESC LIMIT 1), 'not_recorded')
  WHERE id = p_keep;
  INSERT INTO audit_log (clinic_id, actor_user_id, action, entity, entity_id, detail)
  VALUES (k.clinic_id, rc_user_id(), 'patients_merged', 'patient', p_keep::text,
          jsonb_build_object('merged_from', p_from, 'merged_code', f.patient_code));
END $$;
REVOKE ALL ON FUNCTION rc_merge_patients(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_merge_patients(uuid, uuid) TO rc_app;

-- consent withdrawal must reach the clinic admin (spec 3.11): an attention item
ALTER TABLE attention_items DROP CONSTRAINT attention_items_kind_check;
ALTER TABLE attention_items ADD CONSTRAINT attention_items_kind_check CHECK (kind IN (
    'call_not_completed','call_handed_over','unanswered_question','complaint',
    'reschedule_request','cancellation_request','unconfirmed_appointment',
    'no_show_no_rebooking','failed_outbound_call','pending_approval','failed_workflow','consent_withdrawn'));

CREATE OR REPLACE FUNCTION rc_sync_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE patients SET consent_status = NEW.status WHERE id = NEW.patient_id;
  IF NEW.status = 'withdrawn' THEN
    INSERT INTO attention_items (clinic_id, kind, patient_id, reason, urgency)
    VALUES (NEW.clinic_id, 'consent_withdrawn', NEW.patient_id,
            'Patient withdrew consent. Automatic calls and reminders are stopped for this patient.', 2);
  END IF;
  INSERT INTO audit_log (clinic_id, actor_user_id, action, entity, entity_id, detail)
  VALUES (NEW.clinic_id, NEW.recorded_by, 'consent_' || NEW.status, 'patient', NEW.patient_id::text,
          jsonb_build_object('method', NEW.method, 'wording_version', NEW.wording_version));
  RETURN NEW;
END $$;

-- ---------- staff permissions: a clinic admin may only grant what the super admin has switched on ----------
CREATE FUNCTION rc_capability_allowed(p_clinic uuid, p_cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT enabled FROM clinic_features WHERE clinic_id = p_clinic AND feature = 'cap:' || p_cap), true)
$$;
GRANT EXECUTE ON FUNCTION rc_capability_allowed(uuid, text) TO rc_app;
DROP POLICY sc_write ON staff_capabilities;
CREATE POLICY sc_insert ON staff_capabilities FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff')
              AND rc_capability_allowed(clinic_id, capability)));
CREATE POLICY sc_delete ON staff_capabilities FOR DELETE
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff')));

-- Whether a staff member has finished setting up (chosen a password). Reveals nothing else.
CREATE FUNCTION rc_staff_has_password(p_user uuid) RETURNS SETOF boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_credentials WHERE user_id = p_user)
  WHERE rc_is_super() OR EXISTS (SELECT 1 FROM users WHERE id = p_user AND clinic_id = rc_clinic_id())
$$;
GRANT EXECUTE ON FUNCTION rc_staff_has_password(uuid) TO rc_app;
