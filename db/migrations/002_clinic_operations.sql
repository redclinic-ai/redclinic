-- 002: patients, consent, appointments, documents. No revenue, price, fee or visit-value columns (decision D5).

CREATE TABLE patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),           -- permanent internal ID
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_code text NOT NULL,                              -- human-readable ID shown to staff, e.g. RC-20418
  name text NOT NULL,
  phone text,                                              -- never the identity; may change or repeat
  email text,
  date_of_birth date,
  age_years int CHECK (age_years BETWEEN 0 AND 130),
  gender text,
  address text,
  assigned_doctor_id uuid REFERENCES users(id),
  first_problem text,
  consent_status text NOT NULL DEFAULT 'not_recorded' CHECK (consent_status IN ('not_recorded','given','withdrawn')),
  merged_into uuid REFERENCES patients(id),
  registered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clinic_id, patient_code)
);
CREATE INDEX patients_phone_idx ON patients (clinic_id, phone);
CREATE INDEX patients_name_trgm ON patients USING gin (name gin_trgm_ops);
CREATE SEQUENCE patient_code_seq START 10000;

CREATE FUNCTION rc_new_patient_code() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.patient_code IS NULL OR NEW.patient_code = '' THEN
    NEW.patient_code := 'RC-' || nextval('patient_code_seq');
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE patients ALTER COLUMN patient_code DROP NOT NULL;
CREATE TRIGGER patients_code BEFORE INSERT ON patients FOR EACH ROW EXECUTE FUNCTION rc_new_patient_code();
-- the code is permanent
CREATE FUNCTION rc_patient_code_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.patient_code IS DISTINCT FROM OLD.patient_code OR NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'patient id and code are permanent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER patients_fixed BEFORE UPDATE ON patients FOR EACH ROW EXECUTE FUNCTION rc_patient_code_fixed();

-- Demographics: staff need view_patients (edit needs edit_patient).
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_read ON patients FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('view_patients')));
CREATE POLICY p_write ON patients FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('edit_patient')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('edit_patient')));
GRANT SELECT, INSERT, UPDATE ON patients TO rc_app;
GRANT USAGE ON SEQUENCE patient_code_seq TO rc_app;

-- Clinical details are separate so receptionists can register patients without seeing history.
CREATE TABLE patient_clinical (
  patient_id uuid PRIMARY KEY REFERENCES patients(id),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  medical_history text,
  allergies text,
  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE patient_clinical ENABLE ROW LEVEL SECURITY;
CREATE POLICY pc_read ON patient_clinical FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('view_patient_history')));
CREATE POLICY pc_write ON patient_clinical FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('view_patient_history') AND rc_has_capability('edit_patient')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('view_patient_history') AND rc_has_capability('edit_patient')));
GRANT SELECT, INSERT, UPDATE ON patient_clinical TO rc_app;

-- Consent history; patients.consent_status mirrors the latest record.
CREATE TABLE patient_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  status text NOT NULL CHECK (status IN ('given','withdrawn')),
  method text NOT NULL CHECK (method IN ('in_person','signed_form','verbal','uploaded_form','bulk_import_confirmed')),
  wording_version text NOT NULL,
  recorded_by uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_tenant_rls('patient_consents');

CREATE FUNCTION rc_sync_consent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE patients SET consent_status = NEW.status WHERE id = NEW.patient_id;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_sync AFTER INSERT ON patient_consents FOR EACH ROW EXECUTE FUNCTION rc_sync_consent();

-- Appointments. Online fields reserved without any fee or payment columns (see DECISIONS C4).
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  doctor_id uuid NOT NULL REFERENCES users(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','confirmed','completed','no_show','cancelled')),
  appointment_type text NOT NULL DEFAULT 'in_clinic' CHECK (appointment_type IN ('in_clinic','online')),
  reason text,
  booked_via text NOT NULL DEFAULT 'staff' CHECK (booked_via IN ('staff','nepa','import')),
  online_meeting_ref text,                                 -- reserved for V2
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- one doctor cannot have two live appointments that overlap
  CONSTRAINT no_double_booking EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('scheduled','confirmed'))
);
CREATE INDEX appointments_day_idx ON appointments (clinic_id, starts_at);
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY a_read ON appointments FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id)));
CREATE POLICY a_write ON appointments FOR ALL
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_appointments')))
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('manage_appointments')));
GRANT SELECT, INSERT, UPDATE ON appointments TO rc_app;

-- Documents (metadata; the file lives in private storage, referenced by storage_path).
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  doc_type text NOT NULL CHECK (doc_type IN ('prescription','report','image','pdf','note','other')),
  original_filename text,
  mime_type text,
  size_bytes bigint,
  storage_path text,
  description text,
  uploaded_by uuid REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY d_read ON documents FOR SELECT
  USING (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_clinic_active(clinic_id) AND rc_has_capability('view_documents')));
CREATE POLICY d_write ON documents FOR INSERT
  WITH CHECK (rc_is_super() OR (clinic_id = rc_clinic_id() AND rc_has_capability('upload_document')));
GRANT SELECT, INSERT ON documents TO rc_app;
