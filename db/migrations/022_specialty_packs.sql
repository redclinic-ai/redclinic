-- 022 (V2): more speciality packs. Engineering drafts like the Dental Pack (KNOWN_ISSUES K4): each needs review by a
-- practising professional before real patients. Installed switched on for new clinics of that type (like Dental),
-- never automatic; existing clinics of that type get them too.

WITH p AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('dermatology_pack', 'dermatology', 'Skin, hair and cosmetology pack', 1, true, 'draft', 2,
          'Course and session follow-ups for skin and hair clinics. Draft: needs review by a dermatologist.') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT p.id, t.key, t.name, t.description, t.steps::jsonb FROM p, (VALUES
 ('derm_procedure_checkin', 'Check-in after a procedure',
  'The day after a peel, laser, biopsy or other procedure, asks how the skin feels. Redness that is getting worse, blistering or pain goes to staff urgently.',
  '{"trigger":{"event":"appointment_completed","serviceMatch":["peel","laser","biopsy","excision","cautery","microneedling","prp","botox","filler"]},"steps":[
     {"key":"checkin","afterMinutes":1440,"action":"call","purpose":"checkin","onlyIf":"always"}]}'),
 ('derm_session_series', 'Next session of a treatment series',
  'Peels, laser and PRP are given in sessions. Three weeks after a session, if the next one is not booked, calls to book it; a week later, tells staff.',
  '{"trigger":{"event":"appointment_completed","serviceMatch":["peel","laser","prp","microneedling","hair"]},"steps":[
     {"key":"book","afterMinutes":30240,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":40320,"action":"attention","reason":"Treatment series: next session not booked.","onlyIf":"no_upcoming"}]}'),
 ('derm_acne_review', 'Acne course review',
  'Six weeks after an acne visit, if nothing is booked, calls to book the review (acne treatment is judged after 6–8 weeks).',
  '{"trigger":{"event":"weeks_since_last_visit","weeks":6,"serviceMatch":["acne","isotretinoin","pimple"]},"steps":[
     {"key":"book","afterMinutes":0,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

WITH p AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('physio_pack', 'physiotherapy', 'Physiotherapy pack', 1, true, 'draft', 2,
          'Keeps patients on their session plan. Draft: needs review by a physiotherapist.') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT p.id, t.key, t.name, t.description, t.steps::jsonb FROM p, (VALUES
 ('physio_next_session', 'Book the next session',
  'Two days after a session, if the next one is not booked, calls to book it. Five days after, tells staff (patients who stop early often do not recover fully).',
  '{"trigger":{"event":"appointment_completed"},"steps":[
     {"key":"book","afterMinutes":2880,"action":"call","purpose":"follow_up","onlyIf":"no_upcoming"},
     {"key":"tell_staff","afterMinutes":7200,"action":"attention","reason":"Physiotherapy patient stopped booking sessions.","onlyIf":"no_upcoming"}]}'),
 ('physio_exercise_checkin', 'Home exercise check-in',
  'A week after a session, asks how the home exercises are going and whether pain is better or worse. Worse pain goes to staff.',
  '{"trigger":{"event":"appointment_completed"},"steps":[
     {"key":"checkin","afterMinutes":10080,"action":"call","purpose":"checkin","onlyIf":"no_upcoming"}]}'),
 ('physio_discharge_review', 'One-month review after the last session',
  'A month after the last visit, if nothing is booked, offers a short review to check the problem has not come back.',
  '{"trigger":{"event":"weeks_since_last_visit","weeks":4},"steps":[
     {"key":"recall","afterMinutes":0,"action":"call","purpose":"recall","onlyIf":"no_upcoming"}]}')
) AS t(key, name, description, steps);

WITH p AS (
  INSERT INTO workflow_packs (key, clinic_type, name, version, is_active, review_status, format, notes)
  VALUES ('general_pack', 'general', 'General practice pack', 1, true, 'draft', 2,
          'Reviews for long-term conditions. Draft: needs review by a general practitioner.') RETURNING id
)
INSERT INTO workflow_templates (pack_id, key, name, description, steps)
SELECT p.id, t.key, t.name, t.description, t.steps::jsonb FROM p, (VALUES
 ('gp_chronic_review', 'Three-monthly review (diabetes, blood pressure, thyroid)',
  'Three months after a visit for a long-term condition, if nothing is booked, calls to book the review and tests.',
  '{"trigger":{"event":"months_since_last_visit","months":3,"serviceMatch":["diabetes","sugar","bp","hypertension","blood pressure","thyroid"]},"steps":[
     {"key":"recall","afterMinutes":0,"action":"call","purpose":"recall","onlyIf":"no_upcoming"}]}'),
 ('gp_fever_checkin', 'Check-in after a fever visit',
  'Two days after a visit for fever, asks if the fever has settled. A fever that has not settled goes to staff urgently.',
  '{"trigger":{"event":"appointment_completed","serviceMatch":["fever","viral","dengue","typhoid","infection"]},"steps":[
     {"key":"checkin","afterMinutes":2880,"action":"call","purpose":"checkin","onlyIf":"always"}]}')
) AS t(key, name, description, steps);

SELECT rc_install_pack(id) FROM clinics;
