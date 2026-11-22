-- Tenant isolation, permissions, booking, audit and rule tests. Run as the database owner; each test switches to rc_app.
\set ON_ERROR_STOP on
DROP SCHEMA IF EXISTS rct CASCADE;
CREATE SCHEMA rct;

-- Results are emitted as notices (a table insert would be undone by the ROLLBACK in each test block).
CREATE FUNCTION rct.check(p_name text, p_ok boolean, p_info text DEFAULT '') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RAISE NOTICE 'RESULT|%|%|%', CASE WHEN COALESCE(p_ok,false) THEN 'PASS' ELSE 'FAIL' END, p_name, p_info;
END $$;

CREATE FUNCTION rct.as_user(p_user uuid, p_clinic uuid, p_super boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  RESET ROLE; PERFORM rc_set_context(p_user, p_clinic, p_super); SET LOCAL ROLE rc_app;
END $$;

-- run a statement as the current role and record whether it was refused (error or row-level violation)
CREATE FUNCTION rct.refused(p_name text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  BEGIN
    EXECUTE p_sql; GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM rct.check(p_name, n = 0, 'statement affected ' || n || ' rows');
  EXCEPTION WHEN OTHERS THEN
    PERFORM rct.check(p_name, true, SQLERRM);
  END;
END $$;

CREATE FUNCTION rct.allowed(p_name text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql; PERFORM rct.check(p_name, true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM rct.check(p_name, false, SQLERRM);
  END;
END $$;

CREATE FUNCTION rct.count(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint; BEGIN EXECUTE p_sql INTO n; RETURN n; END $$;

-- ---------- seed (as owner) ----------
CREATE TABLE rct.ids (k text PRIMARY KEY, v uuid);
DO $$
DECLARE ca uuid; cb uuid; su uuid; aa uuid; da uuid; ra uuid; ma uuid; ab uuid; pa uuid; pb uuid;
BEGIN
  INSERT INTO clinics(name) VALUES ('Clinic A') RETURNING id INTO ca;
  INSERT INTO clinics(name) VALUES ('Clinic B') RETURNING id INTO cb;
  INSERT INTO users(role,email,display_name) VALUES ('super_admin','founder@rc.test','Founder') RETURNING id INTO su;
  INSERT INTO users(clinic_id,role,email,display_name) VALUES (ca,'clinic_admin','admin.a@rc.test','Admin A') RETURNING id INTO aa;
  INSERT INTO users(clinic_id,role,email,display_name) VALUES (ca,'doctor','doc.a@rc.test','Doctor A') RETURNING id INTO da;
  INSERT INTO users(clinic_id,role,email,display_name) VALUES (ca,'receptionist','rec.a@rc.test','Rec A') RETURNING id INTO ra;
  INSERT INTO users(clinic_id,role,email,display_name) VALUES (ca,'clinic_manager','man.a@rc.test','Manager A') RETURNING id INTO ma;
  INSERT INTO users(clinic_id,role,email,display_name) VALUES (cb,'clinic_admin','admin.b@rc.test','Admin B') RETURNING id INTO ab;
  PERFORM rc_apply_role_preset(da, aa); PERFORM rc_apply_role_preset(ra, aa); PERFORM rc_apply_role_preset(ma, aa);
  INSERT INTO patients(clinic_id,name,phone) VALUES (ca,'Patient A1','9000000001') RETURNING id INTO pa;
  INSERT INTO patients(clinic_id,name,phone) VALUES (cb,'Patient B1','9000000002') RETURNING id INTO pb;
  INSERT INTO patient_clinical(patient_id,clinic_id,allergies) VALUES (pa,ca,'penicillin');
  INSERT INTO rct.ids VALUES ('ca',ca),('cb',cb),('su',su),('aa',aa),('da',da),('ra',ra),('ma',ma),('ab',ab),('pa',pa),('pb',pb);
END $$;
CREATE FUNCTION rct.id(k text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM rct.ids WHERE rct.ids.k = $1 $$;
GRANT USAGE ON SCHEMA rct TO rc_app;
GRANT SELECT ON rct.ids TO rc_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rct TO rc_app;

-- ---------- isolation ----------
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.check('A admin sees only clinic A patients', rct.count('SELECT count(*) FROM patients') = 1);
SELECT rct.check('A admin cannot see clinic B patient by id', rct.count(format('SELECT count(*) FROM patients WHERE id=%L', rct.id('pb'))) = 0);
SELECT rct.check('A admin sees only own clinic row', rct.count('SELECT count(*) FROM clinics') = 1);
SELECT rct.refused('A admin cannot insert a patient into clinic B', format($q$INSERT INTO patients(clinic_id,name) VALUES (%L,'x')$q$, rct.id('cb')));
SELECT rct.refused('A admin cannot update clinic B patient', format($q$UPDATE patients SET name='hacked' WHERE id=%L$q$, rct.id('pb')));
SELECT rct.check('clinic users cannot see the super admin user', rct.count($q$SELECT count(*) FROM users WHERE role='super_admin'$q$) = 0);
SELECT rct.refused('clinic admin cannot create a super admin', $q$INSERT INTO users(role,email,display_name) VALUES ('super_admin','evil@rc.test','Evil')$q$);
SELECT rct.refused('clinic admin cannot create a user in another clinic', format($q$INSERT INTO users(clinic_id,role,email,display_name) VALUES (%L,'doctor','x@rc.test','X')$q$, rct.id('cb')));
SELECT rct.refused('clinic admin cannot edit clinics', $q$UPDATE clinics SET name='renamed'$q$);
SELECT rct.refused('clinic admin cannot change feature switches', format($q$INSERT INTO clinic_features(clinic_id,feature) VALUES (%L,'outbound_calls')$q$, rct.id('ca')));
ROLLBACK;

BEGIN;
SELECT rct.as_user(rct.id('ab'), rct.id('cb'));
SELECT rct.check('B admin sees only clinic B patients', rct.count('SELECT count(*) FROM patients') = 1);
SELECT rct.check('B admin cannot see clinic A clinical notes', rct.count('SELECT count(*) FROM patient_clinical') = 0);
ROLLBACK;

BEGIN;
SELECT rct.as_user(rct.id('su'), NULL, true);
SELECT rct.check('super admin sees all patients', rct.count('SELECT count(*) FROM patients') = 2);
SELECT rct.check('super admin sees all clinics', rct.count('SELECT count(*) FROM clinics') = 2);
SELECT rct.allowed('super admin can suspend a clinic', format($q$UPDATE clinics SET status='suspended' WHERE id=%L$q$, rct.id('ca')));
ROLLBACK;

-- no context at all means no data
BEGIN;
SET LOCAL ROLE rc_app;
SELECT rct.check('no context sees no patients', rct.count('SELECT count(*) FROM patients') = 0);
SELECT rct.check('no context sees no clinics', rct.count('SELECT count(*) FROM clinics') = 0);
ROLLBACK;

-- kill switch
BEGIN;
UPDATE clinics SET status='suspended' WHERE id = rct.id('ca');
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.check('suspended clinic admin sees no patients', rct.count('SELECT count(*) FROM patients') = 0);
SELECT rct.check('suspended clinic admin has no capabilities', NOT rc_has_capability('view_patients'));
ROLLBACK;

-- ---------- permissions ----------
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.check('receptionist can list patients', rct.count('SELECT count(*) FROM patients') = 1);
SELECT rct.check('receptionist cannot read clinical history', rct.count('SELECT count(*) FROM patient_clinical') = 0);
SELECT rct.allowed('receptionist can register a patient', format($q$INSERT INTO patients(clinic_id,name,phone,first_problem) VALUES (%L,'Walk In','9111111111','toothache')$q$, rct.id('ca')));
SELECT rct.refused('receptionist cannot grant themselves history access', format($q$INSERT INTO staff_capabilities(user_id,clinic_id,capability) VALUES (%L,%L,'view_patient_history')$q$, rct.id('ra'), rct.id('ca')));
SELECT rct.refused('receptionist cannot invite staff', format($q$INSERT INTO users(clinic_id,role,email,display_name) VALUES (%L,'doctor','n@rc.test','N')$q$, rct.id('ca')));
SELECT rct.refused('receptionist cannot approve actions', $q$UPDATE approvals SET status='approved'$q$);
SELECT rct.check('receptionist cannot see audit log', rct.count('SELECT count(*) FROM audit_log') = 0);
SELECT rct.check('receptionist cannot see subscriptions', rct.count('SELECT count(*) FROM subscriptions') = 0);
ROLLBACK;

BEGIN;
SELECT rct.as_user(rct.id('da'), rct.id('ca'));
SELECT rct.check('doctor can read clinical history', rct.count('SELECT count(*) FROM patient_clinical') = 1);
SELECT rct.refused('doctor cannot edit workflows', format($q$INSERT INTO clinic_workflows(clinic_id,name) VALUES (%L,'w')$q$, rct.id('ca')));
ROLLBACK;

BEGIN;
SELECT rct.as_user(rct.id('ma'), rct.id('ca'));
SELECT rct.check('manager cannot read clinical history', rct.count('SELECT count(*) FROM patient_clinical') = 0);
SELECT rct.check('manager cannot see billing', rct.count('SELECT count(*) FROM subscriptions') = 0);
ROLLBACK;

-- admin grants and revokes a capability; effect is immediate
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('admin can grant view_patient_history to receptionist', format($q$INSERT INTO staff_capabilities(user_id,clinic_id,capability,granted_by) VALUES (%L,%L,'view_patient_history',%L)$q$, rct.id('ra'), rct.id('ca'), rct.id('aa')));
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.check('receptionist can read history after grant', rct.count('SELECT count(*) FROM patient_clinical') = 1);
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('admin can revoke it', format($q$DELETE FROM staff_capabilities WHERE user_id=%L AND capability='view_patient_history'$q$, rct.id('ra')));
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.check('receptionist loses history access after revoke', rct.count('SELECT count(*) FROM patient_clinical') = 0);
ROLLBACK;

-- deactivated user loses access
BEGIN;
UPDATE users SET status='deactivated' WHERE id = rct.id('da');
SELECT rct.as_user(rct.id('da'), rct.id('ca'));
SELECT rct.check('deactivated doctor has no capability', NOT rc_has_capability('view_patient_history'));
ROLLBACK;

-- ---------- patients ----------
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.refused('patient id cannot change', format($q$UPDATE patients SET id=gen_random_uuid() WHERE id=%L$q$, rct.id('pa')));
SELECT rct.refused('patient code cannot change', format($q$UPDATE patients SET patient_code='RC-1' WHERE id=%L$q$, rct.id('pa')));
SELECT rct.allowed('phone number can change', format($q$UPDATE patients SET phone='9222222222' WHERE id=%L$q$, rct.id('pa')));
SELECT rct.check('patient id is unchanged after phone change', rct.count(format($q$SELECT count(*) FROM patients WHERE id=%L AND phone='9222222222'$q$, rct.id('pa'))) = 1);
SELECT rct.allowed('two patients can share a phone number', format($q$INSERT INTO patients(clinic_id,name,phone) VALUES (%L,'Sibling','9222222222')$q$, rct.id('ca')));
SELECT rct.check('patient code was generated', rct.count($q$SELECT count(*) FROM patients WHERE patient_code LIKE 'RC-%'$q$) >= 1);
SELECT rct.allowed('consent can be recorded', format($q$INSERT INTO patient_consents(clinic_id,patient_id,status,method,wording_version,recorded_by) VALUES (%L,%L,'given','in_person','v1',%L)$q$, rct.id('ca'), rct.id('pa'), rct.id('ra')));
SELECT rct.check('patient consent status follows the record', rct.count(format($q$SELECT count(*) FROM patients WHERE id=%L AND consent_status='given'$q$, rct.id('pa'))) = 1);
SELECT rct.allowed('consent can be withdrawn', format($q$INSERT INTO patient_consents(clinic_id,patient_id,status,method,wording_version,recorded_by) VALUES (%L,%L,'withdrawn','verbal','v1',%L)$q$, rct.id('ca'), rct.id('pa'), rct.id('ra')));
SELECT rct.check('withdrawal updates the status', rct.count(format($q$SELECT count(*) FROM patients WHERE id=%L AND consent_status='withdrawn'$q$, rct.id('pa'))) = 1);
ROLLBACK;

-- ---------- appointments ----------
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.allowed('book an appointment', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-01 10:00+05:30','2026-12-01 10:30+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('da')));
SELECT rct.refused('overlapping booking for the same doctor is rejected', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-01 10:15+05:30','2026-12-01 10:45+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('da')));
SELECT rct.allowed('back-to-back booking is allowed', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-01 10:30+05:30','2026-12-01 11:00+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('da')));
SELECT rct.allowed('cancel the first', format($q$UPDATE appointments SET status='cancelled' WHERE starts_at='2026-12-01 10:00+05:30'$q$));
SELECT rct.allowed('slot is free again after cancellation', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-01 10:00+05:30','2026-12-01 10:30+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('da')));
SELECT rct.refused('end must be after start', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-02 10:30+05:30','2026-12-02 10:00+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('da')));
ROLLBACK;

-- cross-tenant references must be rejected even when the caller owns the new row
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.refused('appointment cannot reference a patient from another clinic', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-03 10:00+05:30','2026-12-03 10:30+05:30')$q$, rct.id('ca'), rct.id('pb'), rct.id('da')));
ROLLBACK;


BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.refused('appointment cannot use a non-doctor', format($q$INSERT INTO appointments(clinic_id,patient_id,doctor_id,starts_at,ends_at) VALUES (%L,%L,%L,'2026-12-04 10:00+05:30','2026-12-04 10:30+05:30')$q$, rct.id('ca'), rct.id('pa'), rct.id('ma')));
SELECT rct.refused('document cannot reference a patient from another clinic', format($q$INSERT INTO documents(clinic_id,patient_id,doc_type) VALUES (%L,%L,'note')$q$, rct.id('ca'), rct.id('pb')));
SELECT rct.refused('consent cannot reference a patient from another clinic', format($q$INSERT INTO patient_consents(clinic_id,patient_id,status,method,wording_version) VALUES (%L,%L,'given','verbal','v1')$q$, rct.id('ca'), rct.id('pb')));
SELECT rct.refused('call cannot be linked to a patient from another clinic', format($q$INSERT INTO calls(clinic_id,patient_id,direction) VALUES (%L,%L,'inbound')$q$, rct.id('ca'), rct.id('pb')));
SELECT rct.refused('attention item cannot reference a patient from another clinic', format($q$INSERT INTO attention_items(clinic_id,kind,patient_id,reason) VALUES (%L,'complaint',%L,'x')$q$, rct.id('ca'), rct.id('pb')));
SELECT rct.refused('patient cannot be assigned to a doctor of another clinic', format($q$UPDATE patients SET assigned_doctor_id=%L WHERE id=%L$q$, rct.id('ab'), rct.id('pa')));
ROLLBACK;

-- ---------- documents ----------
BEGIN;
SELECT rct.as_user(rct.id('ra'), rct.id('ca'));
SELECT rct.allowed('receptionist can upload a document record', format($q$INSERT INTO documents(clinic_id,patient_id,doc_type,original_filename,storage_path) VALUES (%L,%L,'prescription','rx.jpg','a/rx.jpg')$q$, rct.id('ca'), rct.id('pa')));
SELECT rct.check('receptionist cannot open documents without view_documents', rct.count('SELECT count(*) FROM documents') = 0);
SELECT rct.as_user(rct.id('da'), rct.id('ca'));
SELECT rct.check('doctor can open documents', rct.count('SELECT count(*) FROM documents') = 1);
ROLLBACK;

-- ---------- calls and transcripts ----------
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('record a simulated call', format($q$INSERT INTO calls(clinic_id,direction,is_simulated) VALUES (%L,'inbound',true)$q$, rct.id('ca')));
SELECT rct.allowed('add a transcript segment', format($q$INSERT INTO call_transcripts(clinic_id,call_id,seq,speaker,text_original) SELECT clinic_id,id,1,'caller','hello' FROM calls$q$));
SELECT rct.refused('recognised text cannot be overwritten', $q$UPDATE call_transcripts SET text_original='edited'$q$);
SELECT rct.allowed('a human correction is stored separately', format($q$UPDATE call_transcripts SET text_corrected='Hello', corrected_by=%L$q$, rct.id('aa')));
SELECT rct.check('original text is kept after correction', rct.count($q$SELECT count(*) FROM call_transcripts WHERE text_original='hello' AND text_corrected='Hello'$q$) = 1);
ROLLBACK;

-- ---------- approvals ----------
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('NEPA action queued for approval', format($q$INSERT INTO approvals(clinic_id,requested_by,action_type) VALUES (%L,'nepa','reschedule')$q$, rct.id('ca')));
SELECT rct.as_user(rct.id('ma'), rct.id('ca'));
SELECT rct.check('manager can see the queue', rct.count('SELECT count(*) FROM approvals') = 1);
SELECT rct.refused('manager cannot approve without the grant', $q$UPDATE approvals SET status='approved'$q$);
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('admin can approve', format($q$UPDATE approvals SET status='approved', decided_by=%L, decided_at=now()$q$, rct.id('aa')));
ROLLBACK;

-- ---------- audit log ----------
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('admin can append to the audit log', format($q$INSERT INTO audit_log(clinic_id,actor_user_id,action) VALUES (%L,%L,'test')$q$, rct.id('ca'), rct.id('aa')));
SELECT rct.refused('audit log rows cannot be changed', $q$UPDATE audit_log SET action='x'$q$);
SELECT rct.refused('audit log rows cannot be deleted', $q$DELETE FROM audit_log$q$);
SELECT rct.refused('audit entries cannot be written for another clinic', format($q$INSERT INTO audit_log(clinic_id,action) VALUES (%L,'x')$q$, rct.id('cb')));
SELECT rct.check('admin can read own clinic audit log', rct.count('SELECT count(*) FROM audit_log') = 1);
ROLLBACK;

-- ---------- workflow packs ----------
DO $$
DECLARE pk uuid;
BEGIN
  INSERT INTO workflow_packs(key,clinic_type,name) VALUES ('test_pack','dental','Test pack') RETURNING id INTO pk;
  INSERT INTO workflow_templates(pack_id,key,name,steps) VALUES (pk,'t1','Test template','[{"call":1}]');
END $$;
BEGIN;
SELECT rct.check('pack installs for a dental clinic', rc_install_pack(rct.id('ca')) = 1);
SELECT rct.check('installing twice adds nothing', rc_install_pack(rct.id('ca')) = 0);
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.allowed('clinic edits its copy', $q$UPDATE clinic_workflows SET steps='[{"call":3}]', edited_by_clinic=true$q$);
SELECT rct.check('master template is untouched by the edit', rct.count($q$SELECT count(*) FROM workflow_templates WHERE steps='[{"call":1}]'$q$) = 1);
SELECT rct.refused('clinic cannot edit master templates', $q$UPDATE workflow_templates SET steps='[]'$q$);
SELECT rct.check('automatic mode is off by default', rct.count('SELECT count(*) FROM clinic_workflows WHERE automatic_enabled') = 0);
ROLLBACK;
DELETE FROM workflow_templates WHERE key='t1'; DELETE FROM workflow_packs WHERE key='test_pack';

-- ---------- billing ----------
DO $$
DECLARE p uuid;
BEGIN
  INSERT INTO packages(name) VALUES ('test') RETURNING id INTO p;
  INSERT INTO subscription_events(provider,provider_event_id,event_type) VALUES ('simulated','evt_1','payment.captured');
  BEGIN
    INSERT INTO subscription_events(provider,provider_event_id,event_type) VALUES ('simulated','evt_1','payment.captured');
    PERFORM rct.check('duplicate payment event is rejected (idempotency)', false);
  EXCEPTION WHEN unique_violation THEN
    PERFORM rct.check('duplicate payment event is rejected (idempotency)', true);
  END;
END $$;
BEGIN;
SELECT rct.as_user(rct.id('aa'), rct.id('ca'));
SELECT rct.refused('clinic admin cannot create a subscription', format($q$INSERT INTO subscriptions(clinic_id,package_id,billing_period) SELECT %L, id, 'monthly' FROM packages$q$, rct.id('ca')));
SELECT rct.check('clinic users cannot read payment events', rct.count('SELECT count(*) FROM subscription_events') = 0);
ROLLBACK;

-- ---------- no clinic revenue anywhere (decision D5) ----------
SELECT rct.check('no revenue, price, fee, income or visit-value columns exist',
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema='public' AND column_name ~* '(revenue|price|fee|income|visit_value|amount|payment_status)') = 0,
  (SELECT string_agg(table_name||'.'||column_name, ', ') FROM information_schema.columns
   WHERE table_schema='public' AND column_name ~* '(revenue|price|fee|income|visit_value|amount|payment_status)'));

-- ---------- every clinic-owned table has row-level security ----------
SELECT rct.check('all tables with clinic_id have RLS enabled',
  (SELECT count(*) FROM information_schema.columns c
   JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
   WHERE c.table_schema='public' AND c.column_name='clinic_id' AND k.relkind='r' AND NOT k.relrowsecurity) = 0,
  (SELECT string_agg(c.table_name, ', ') FROM information_schema.columns c
   JOIN pg_class k ON k.relname = c.table_name AND k.relnamespace = 'public'::regnamespace
   WHERE c.table_schema='public' AND c.column_name='clinic_id' AND k.relkind='r' AND NOT k.relrowsecurity));

-- ---------- report ----------
-- (counted by scripts/test-db.sh from the RESULT notices)
