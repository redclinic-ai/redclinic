-- 004: a row may only reference rows of its own clinic (foreign keys alone do not guarantee this).
CREATE FUNCTION rc_same_clinic() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  col text := TG_ARGV[0];
  ref text := TG_ARGV[1];
  ref_id uuid;
  ref_clinic uuid;
BEGIN
  EXECUTE format('SELECT ($1).%I', col) INTO ref_id USING NEW;
  IF ref_id IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT clinic_id FROM %I WHERE id = $1', ref) INTO ref_clinic USING ref_id;
  IF ref_clinic IS DISTINCT FROM NEW.clinic_id THEN
    RAISE EXCEPTION 'cross-clinic reference rejected: %.% must belong to the same clinic', TG_TABLE_NAME, col
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION rc_add_same_clinic(p_table text, p_col text, p_ref text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION rc_same_clinic(%L, %L)',
                 'same_clinic_' || p_col, p_table, p_col, p_ref);
END $$;

SELECT rc_add_same_clinic('patients','assigned_doctor_id','users');
SELECT rc_add_same_clinic('patient_clinical','patient_id','patients');
SELECT rc_add_same_clinic('patient_consents','patient_id','patients');
SELECT rc_add_same_clinic('appointments','patient_id','patients');
SELECT rc_add_same_clinic('appointments','doctor_id','users');
SELECT rc_add_same_clinic('documents','patient_id','patients');
SELECT rc_add_same_clinic('calls','patient_id','patients');
SELECT rc_add_same_clinic('call_transcripts','call_id','calls');
SELECT rc_add_same_clinic('attention_items','patient_id','patients');
SELECT rc_add_same_clinic('attention_items','call_id','calls');
SELECT rc_add_same_clinic('attention_items','appointment_id','appointments');
SELECT rc_add_same_clinic('attention_items','approval_id','approvals');
SELECT rc_add_same_clinic('staff_capabilities','user_id','users');

-- appointments must be with a doctor
CREATE FUNCTION rc_appointment_doctor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.doctor_id AND role = 'doctor') THEN
    RAISE EXCEPTION 'appointments must be booked with a doctor' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointment_doctor BEFORE INSERT OR UPDATE OF doctor_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION rc_appointment_doctor();
