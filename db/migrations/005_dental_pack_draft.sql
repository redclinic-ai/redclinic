-- 005: DRAFT Dental Pack, installed automatically (editable) for dental clinics.
-- The founder's Dental Pack specification was not supplied (KNOWN_ISSUES K2). This content is engineering's
-- draft of common dental follow-up workflows. It must be reviewed by the founder and a dental professional
-- before real use. Every step that contacts a patient needs approval until the clinic opts in to automatic mode.

ALTER TABLE workflow_packs ADD COLUMN review_status text NOT NULL DEFAULT 'draft'
  CHECK (review_status IN ('draft','reviewed'));

WITH p AS (
  INSERT INTO workflow_packs(key, clinic_type, name, review_status)
  VALUES ('dental_pack', 'dental', 'Dental Pack', 'draft') RETURNING id
)
INSERT INTO workflow_templates(pack_id, key, name, steps)
SELECT p.id, t.key, t.name, t.steps::jsonb FROM p, (VALUES
 ('appointment_reminder', 'Appointment reminder',
  '[{"trigger":"appointment_scheduled","wait_before_appointment":"24h","action":"remind_patient","channel":"call_or_message","needs_approval":true},
    {"if":"no_reply","wait":"4h","action":"needs_attention","reason":"unconfirmed_appointment"}]'),
 ('missed_appointment_followup', 'Missed appointment follow-up',
  '[{"trigger":"appointment_no_show","wait":"2h","action":"contact_patient","purpose":"offer_new_slot","needs_approval":true},
    {"if":"no_rebooking","wait":"48h","action":"needs_attention","reason":"no_show_no_rebooking"}]'),
 ('post_procedure_checkin', 'Check-in after a procedure',
  '[{"trigger":"appointment_completed","applies_to":"procedure","wait":"24h","action":"contact_patient","purpose":"ask_how_they_feel","needs_approval":true},
    {"if":"patient_reports_pain_or_swelling","action":"hand_to_staff","urgency":1}]'),
 ('multi_visit_treatment_followup', 'Multi-visit treatment follow-up',
  '[{"trigger":"treatment_visit_completed","if":"next_visit_not_booked","wait":"7d","action":"contact_patient","purpose":"book_next_visit","needs_approval":true},
    {"if":"still_not_booked","wait":"7d","action":"needs_attention","reason":"no_show_no_rebooking"}]'),
 ('routine_recall', 'Routine check-up recall',
  '[{"trigger":"months_since_last_visit","months":6,"action":"contact_patient","purpose":"offer_checkup","needs_approval":true}]'),
 ('new_enquiry_followup', 'New enquiry follow-up',
  '[{"trigger":"enquiry_without_booking","wait":"1d","action":"contact_patient","purpose":"offer_appointment","needs_approval":true},
    {"if":"no_reply","wait":"3d","action":"needs_attention","reason":"unanswered_question"}]'),
 ('urgent_pain_handover', 'Urgent pain or swelling handover',
  '[{"trigger":"caller_reports_severe_pain_swelling_bleeding_or_trauma","action":"hand_to_staff","urgency":1,"needs_approval":false,"note":"NEPA never gives medical advice; staff decide"}]')
) AS t(key, name, steps);

-- A new clinic gets the pack for its type automatically (editable copy; automatic mode stays off).
CREATE FUNCTION rc_install_pack_on_clinic() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM rc_install_pack(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER clinics_install_pack AFTER INSERT ON clinics FOR EACH ROW EXECUTE FUNCTION rc_install_pack_on_clinic();
