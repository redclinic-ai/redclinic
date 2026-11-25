-- 021 (V2): fuller patient records, document reading, and online consultations.
-- Records stay "light" (founder): visit notes with vitals, conditions, medicines, allergies and lab values, each
-- linked to where it came from (a visit, a document page, or typed by staff), so a doctor can always open the source.
-- Document reading: text is extracted from PDFs and photos, likely items are suggested, and nothing enters the record
-- until a doctor confirms it. Online consultations: a private video room per appointment (Jitsi, open source); no fees.

INSERT INTO capabilities (code, description) VALUES
  ('write_clinical', 'Write visit notes and prescriptions, and confirm items read from documents')
ON CONFLICT DO NOTHING;
INSERT INTO role_presets (role, capability) VALUES ('doctor', 'write_clinical') ON CONFLICT DO NOTHING;
INSERT INTO staff_capabilities (user_id, clinic_id, capability, granted_by)
  SELECT u.id, u.clinic_id, 'write_clinical', NULL FROM users u WHERE u.role = 'doctor' AND u.clinic_id IS NOT NULL ON CONFLICT DO NOTHING;

-- Read with view_patient_history; write with write_clinical. Super admin access follows the clinic's data policy.
CREATE FUNCTION rc_enable_clinical_rls(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format($p$CREATE POLICY cl_read ON %s FOR SELECT
    USING ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_clinic_active(rc_clinic_id())) AND (SELECT rc_has_capability('view_patient_history'))))$p$, p_table);
  EXECUTE format($p$CREATE POLICY cl_write ON %s FOR INSERT
    WITH CHECK ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_clinic_active(rc_clinic_id())) AND (SELECT rc_has_capability('write_clinical'))))$p$, p_table);
  EXECUTE format($p$CREATE POLICY cl_update ON %s FOR UPDATE
    USING ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_clinic_active(rc_clinic_id())) AND (SELECT rc_has_capability('write_clinical'))))
    WITH CHECK ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_has_capability('write_clinical'))))$p$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO rc_app', p_table);   -- no DELETE: records are corrected, not erased
  INSERT INTO patient_data_tables VALUES (p_table::text) ON CONFLICT DO NOTHING;
  PERFORM rc_restrict_super_on(p_table::text);
END $$;

-- ---------- visits ----------
CREATE TABLE visit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  appointment_id uuid REFERENCES appointments(id),
  doctor_id uuid REFERENCES users(id),
  visit_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  is_online boolean NOT NULL DEFAULT false,
  chief_complaint text CHECK (length(chief_complaint) <= 1000),
  findings text CHECK (length(findings) <= 4000),
  diagnosis text CHECK (length(diagnosis) <= 1000),
  advice text CHECK (length(advice) <= 4000),
  follow_up text CHECK (length(follow_up) <= 500),
  vitals jsonb NOT NULL DEFAULT '{}',          -- {bp_systolic, bp_diastolic, pulse, temperature_c, weight_kg, height_cm, spo2}
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','signed')),
  signed_at timestamptz,
  addenda jsonb NOT NULL DEFAULT '[]',         -- signed notes are not edited; corrections are added here
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX visit_notes_patient ON visit_notes (clinic_id, patient_id, visit_date DESC);
CREATE UNIQUE INDEX visit_notes_one_per_appointment ON visit_notes (appointment_id) WHERE appointment_id IS NOT NULL;
SELECT rc_enable_clinical_rls('visit_notes');

-- a signed note cannot be changed except by adding to its addenda
CREATE FUNCTION rc_visit_note_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'signed' AND (NEW.chief_complaint, NEW.findings, NEW.diagnosis, NEW.advice, NEW.follow_up, NEW.vitals, NEW.status, NEW.patient_id, NEW.visit_date)
     IS DISTINCT FROM (OLD.chief_complaint, OLD.findings, OLD.diagnosis, OLD.advice, OLD.follow_up, OLD.vitals, OLD.status, OLD.patient_id, OLD.visit_date) THEN
    RAISE EXCEPTION 'A signed visit note cannot be changed. Add a correction instead.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER visit_notes_locked BEFORE UPDATE ON visit_notes FOR EACH ROW EXECUTE FUNCTION rc_visit_note_locked();

-- ---------- structured record items (each has a source) ----------
CREATE TABLE patient_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','entered_in_error')),
  since text CHECK (length(since) <= 60),
  notes text CHECK (length(notes) <= 1000),
  source text NOT NULL CHECK (source IN ('manual','visit','document')),
  visit_id uuid REFERENCES visit_notes(id),
  document_id uuid REFERENCES documents(id),
  evidence text CHECK (length(evidence) <= 500),        -- the line of the document it was read from
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_clinical_rls('patient_conditions');

CREATE TABLE patient_medications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  strength text CHECK (length(strength) <= 60),
  dose text CHECK (length(dose) <= 60),
  frequency text CHECK (length(frequency) <= 60),
  duration text CHECK (length(duration) <= 60),
  route text CHECK (length(route) <= 40),
  instructions text CHECK (length(instructions) <= 300),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped','entered_in_error')),
  start_date date,
  source text NOT NULL CHECK (source IN ('manual','visit','document')),
  visit_id uuid REFERENCES visit_notes(id),
  document_id uuid REFERENCES documents(id),
  evidence text CHECK (length(evidence) <= 500),
  prescribed_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_medications_visit ON patient_medications (visit_id) WHERE visit_id IS NOT NULL;
SELECT rc_enable_clinical_rls('patient_medications');

CREATE TABLE patient_allergies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  substance text NOT NULL CHECK (length(substance) BETWEEN 2 AND 120),
  reaction text CHECK (length(reaction) <= 300),
  severity text NOT NULL DEFAULT 'unknown' CHECK (severity IN ('mild','moderate','severe','unknown')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','entered_in_error')),
  source text NOT NULL CHECK (source IN ('manual','visit','document')),
  document_id uuid REFERENCES documents(id),
  evidence text CHECK (length(evidence) <= 500),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_clinical_rls('patient_allergies');

CREATE TABLE lab_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  test_name text NOT NULL CHECK (length(test_name) BETWEEN 2 AND 120),
  value text NOT NULL CHECK (length(value) <= 60),
  unit text CHECK (length(unit) <= 30),
  reference_range text CHECK (length(reference_range) <= 60),
  flag text CHECK (flag IN ('normal','high','low','abnormal')),
  taken_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','entered_in_error')),
  source text NOT NULL CHECK (source IN ('manual','document')),
  document_id uuid REFERENCES documents(id),
  evidence text CHECK (length(evidence) <= 500),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_results_patient ON lab_results (clinic_id, patient_id, test_name, taken_on DESC);
SELECT rc_enable_clinical_rls('lab_results');

-- ---------- document reading ----------
CREATE TABLE document_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id uuid NOT NULL REFERENCES clinics(id),
  document_id uuid NOT NULL UNIQUE REFERENCES documents(id),
  patient_id uuid NOT NULL REFERENCES patients(id),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','failed','confirmed','dismissed')),
  method text NOT NULL,                     -- pdf_text, ocr, simulated
  language text,
  pages int,
  confidence numeric(5,2),                  -- 0-100, from OCR; NULL for digital PDFs
  text text CHECK (length(text) <= 200000),
  items jsonb NOT NULL DEFAULT '[]',        -- suggestions: [{key, kind, fields, evidence: {page, line, text}}]
  error text,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- reading the text needs history access; the extraction job (a doctor's or staff request) writes with upload rights
ALTER TABLE document_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY dx_read ON document_extractions FOR SELECT
  USING ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_clinic_active(rc_clinic_id())) AND (SELECT rc_has_capability('view_patient_history'))));
CREATE POLICY dx_insert ON document_extractions FOR INSERT
  WITH CHECK ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND (SELECT rc_clinic_active(rc_clinic_id())) AND ((SELECT rc_has_capability('upload_document')) OR (SELECT rc_has_capability('write_clinical')))));
CREATE POLICY dx_update ON document_extractions FOR UPDATE
  USING ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND ((SELECT rc_has_capability('upload_document')) OR (SELECT rc_has_capability('write_clinical')))))
  WITH CHECK ((SELECT rc_is_super()) OR ((clinic_id = (SELECT rc_clinic_id())) AND ((SELECT rc_has_capability('upload_document')) OR (SELECT rc_has_capability('write_clinical')))));
GRANT SELECT, INSERT, UPDATE ON document_extractions TO rc_app;
INSERT INTO patient_data_tables VALUES ('document_extractions') ON CONFLICT DO NOTHING;
SELECT rc_restrict_super_on('document_extractions');

-- ---------- online consultations ----------
CREATE TABLE clinic_telehealth (
  clinic_id uuid PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL DEFAULT 'jitsi' CHECK (provider IN ('jitsi')),
  jitsi_domain text NOT NULL DEFAULT 'meet.jit.si' CHECK (jitsi_domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT rc_enable_settings_rls('clinic_telehealth');
-- appointment_type already allows 'in_clinic' and 'online'; the meeting room name goes in online_meeting_ref.
