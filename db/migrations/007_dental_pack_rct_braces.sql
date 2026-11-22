-- 007: the V1 spec (section 3.10) names RCT, braces and recall as dental workflows. Adds the two missing drafts.
-- Still engineering drafts pending dental-professional review (KNOWN_ISSUES K4).
INSERT INTO workflow_templates(pack_id, key, name, steps)
SELECT p.id, t.key, t.name, t.steps::jsonb FROM workflow_packs p, (VALUES
 ('rct_visit_sequence', 'Root canal (RCT) visit sequence',
  '[{"trigger":"rct_visit_completed","if":"next_visit_not_booked","wait":"3d","action":"contact_patient","purpose":"book_next_rct_visit","needs_approval":true},
    {"trigger":"rct_visit_completed","wait":"24h","action":"contact_patient","purpose":"ask_how_they_feel","needs_approval":true},
    {"if":"patient_reports_pain_or_swelling","action":"hand_to_staff","urgency":1},
    {"if":"still_not_booked","wait":"7d","action":"needs_attention","reason":"no_show_no_rebooking"}]'),
 ('braces_adjustment_reminder', 'Braces adjustment reminder',
  '[{"trigger":"weeks_since_last_adjustment","weeks":4,"if":"no_upcoming_appointment","action":"contact_patient","purpose":"book_adjustment","needs_approval":true},
    {"if":"no_reply","wait":"3d","action":"needs_attention","reason":"unanswered_question"}]')
) AS t(key, name, steps)
WHERE p.key = 'dental_pack';
-- Clinics created before this migration receive the new templates when the pack is installed again.
SELECT rc_install_pack(id) FROM clinics WHERE clinic_type = 'dental';
