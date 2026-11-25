-- Dental Pack auto-install and results counts. Needs the seed from 001 (schema rct).
\set ON_ERROR_STOP on
SELECT rct.check('dental clinic got the Dental Pack copied automatically',
  (SELECT count(*) FROM clinic_workflows WHERE clinic_id = rct.id('ca')) >= 7);
SELECT rct.check('copied workflows are not automatic by default',
  (SELECT count(*) FROM clinic_workflows WHERE clinic_id = rct.id('ca') AND automatic_enabled) = 0);
SELECT rct.check('Dental Pack is marked draft until reviewed',
  (SELECT review_status FROM workflow_packs WHERE key='dental_pack' AND is_active) = 'draft');
SELECT rct.check('only one version of each pack is active',
  (SELECT count(*) FROM (SELECT key FROM workflow_packs WHERE is_active GROUP BY key HAVING count(*) > 1) x) = 0);
SELECT rct.check('every active template has a trigger and at least one step',
  (SELECT count(*) FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id
   WHERE p.is_active AND (t.steps->'trigger'->>'event' IS NULL OR jsonb_array_length(t.steps->'steps') = 0)) = 0);
SELECT rct.check('dental clinic has the core and dental workflows (format 2)',
  (SELECT count(DISTINCT template_key) FROM clinic_workflows WHERE clinic_id = rct.id('ca') AND step_format = 2 AND coalesce(pack_key,'') <> 'whatsapp') = 7);
SELECT rct.check('the WhatsApp pack is installed switched off',
  (SELECT count(*) FROM clinic_workflows WHERE clinic_id = rct.id('ca') AND pack_key = 'whatsapp' AND NOT enabled) = 4
  AND NOT EXISTS (SELECT 1 FROM clinic_workflows WHERE clinic_id = rct.id('ca') AND pack_key = 'whatsapp' AND enabled));

-- editing a clinic copy never changes the master template
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
UPDATE clinic_workflows SET steps='{}', edited_by_clinic=true
  WHERE clinic_id = rct.id('ca') AND template_key = 'routine_recall' AND step_format = 2;
SELECT rct.check('master template unchanged after a clinic edit',
  (SELECT jsonb_array_length(t.steps->'steps') FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id
   WHERE p.key = 'core' AND t.key = 'routine_recall') = 1);
ROLLBACK;

-- results: counts only, simulated excluded by default, permission needed
DO $$
DECLARE ca uuid := rct.id('ca'); pa uuid := rct.id('pa'); da uuid := rct.id('da');
BEGIN
  INSERT INTO calls(clinic_id,direction,is_simulated,status,handled_by_nepa) VALUES (ca,'inbound',false,'completed',true);
  INSERT INTO calls(clinic_id,direction,is_simulated,status,handled_by_nepa,handed_to_staff) VALUES (ca,'inbound',false,'handed_to_staff',true,true);
  INSERT INTO calls(clinic_id,direction,is_simulated,status,handled_by_nepa) VALUES (ca,'inbound',true,'completed',true);
  INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at,booked_via,status)
    VALUES (ca,pa,da,now()+interval '1 day',now()+interval '1 day 30 min','nepa','scheduled');
END $$;
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.check('results exclude simulated calls by default',
  rct.count($q$SELECT value FROM rc_results_counts(now()-interval '1 day', now()+interval '3 days') WHERE metric='calls_total'$q$) = 2);
SELECT rct.check('results can include simulated calls when asked',
  rct.count($q$SELECT value FROM rc_results_counts(now()-interval '1 day', now()+interval '3 days', true) WHERE metric='calls_total'$q$) = 3);
SELECT rct.check('handed-to-staff calls counted separately',
  rct.count($q$SELECT value FROM rc_results_counts(now()-interval '1 day', now()+interval '3 days') WHERE metric='calls_handed_to_staff'$q$) = 1);
SELECT rct.check('appointments booked by NEPA counted',
  rct.count($q$SELECT value FROM rc_results_counts(now()-interval '1 day', now()+interval '3 days') WHERE metric='appointments_booked_by_nepa'$q$) = 1);
ROLLBACK;
BEGIN;
SELECT rct.as_user(rct.id('ab'), rct.id('cb'));
SELECT rct.check('another clinic sees none of clinic A results',
  rct.count($q$SELECT value FROM rc_results_counts(now()-interval '1 day', now()+interval '3 days', true) WHERE metric='calls_total'$q$) = 0);
ROLLBACK;
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.refused('receptionist without view_results cannot read results',
  $q$SELECT * FROM rc_results_counts(now()-interval '1 day', now())$q$);
ROLLBACK;

SELECT rct.check('RCT, braces and recall workflows exist in the pack',
  (SELECT count(*) FROM workflow_templates t JOIN workflow_packs p ON p.id = t.pack_id
   WHERE p.is_active AND t.key IN ('rct_next_visit','braces_adjustment','routine_recall')) = 3);
