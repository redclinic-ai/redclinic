-- 008: authentication. Passwords, sessions, password reset / staff invitation tokens, login rate limiting,
-- and self-serve clinic signup.
--
-- None of these tables are granted to rc_app. The application reaches them only through the SECURITY DEFINER
-- functions below, because a login happens before any tenant context exists. Tokens are stored as SHA-256
-- hashes; the raw token only ever lives in the user's cookie or email link. Password hashing (scrypt) is done
-- in the application, so the database never sees a plain password.

CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

-- purpose 'reset' = forgot password, 'invite' = first password for a new staff member
CREATE TABLE auth_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('reset','invite')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text,
  success boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_at ON login_attempts(lower(email), at);

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
-- (no policies and no grants: rc_app cannot touch these tables directly)

-- Emails are compared case-insensitively everywhere.
CREATE UNIQUE INDEX users_email_lower ON users(lower(email));

-- ---------- login ----------
-- Returns the stored hash so the application can verify it, plus the recent failure count for rate limiting.
-- Returns no row for an unknown email (the application still spends time hashing, so timing does not leak).
CREATE FUNCTION rc_auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, user_status text, role text, clinic_id uuid,
               clinic_status text, recent_failures int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, c.password_hash, u.status, u.role, u.clinic_id, cl.status,
         (SELECT count(*)::int FROM login_attempts a
           WHERE lower(a.email) = lower(p_email) AND NOT a.success AND a.at > now() - interval '15 minutes')
  FROM users u
  LEFT JOIN user_credentials c ON c.user_id = u.id
  LEFT JOIN clinics cl ON cl.id = u.clinic_id
  WHERE lower(u.email) = lower(p_email)
$$;

CREATE FUNCTION rc_auth_recent_failures(p_email text) RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM login_attempts
  WHERE lower(email) = lower(p_email) AND NOT success AND at > now() - interval '15 minutes'
$$;

CREATE FUNCTION rc_auth_record_attempt(p_email text, p_ip text, p_success boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO login_attempts(email, ip, success) VALUES (lower(p_email), p_ip, p_success);
  IF p_success THEN
    -- a successful login clears the failure window for that email
    DELETE FROM login_attempts WHERE lower(email) = lower(p_email) AND NOT success;
  END IF;
END $$;

-- ---------- sessions ----------
CREATE FUNCTION rc_session_create(p_user uuid, p_token_hash bytea, p_ttl interval, p_ip text, p_ua text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE sid uuid; u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_user;
  IF NOT FOUND OR u.status <> 'active' THEN RAISE EXCEPTION 'user not active'; END IF;
  INSERT INTO sessions(token_hash, user_id, expires_at, ip, user_agent)
  VALUES (p_token_hash, p_user, now() + p_ttl, p_ip, left(p_ua, 300)) RETURNING id INTO sid;
  INSERT INTO audit_log(clinic_id, actor_user_id, actor_is_super, action, entity, entity_id, detail)
  VALUES (u.clinic_id, u.id, u.role = 'super_admin', 'login', 'session', sid::text, jsonb_build_object('ip', p_ip));
  RETURN sid;
END $$;

-- Resolves a cookie token to who is signed in. Returns nothing if the session is expired or revoked or the
-- user is deactivated. A suspended clinic still resolves (so the app can show "account suspended"), but row-level
-- security returns no clinic data while suspended.
CREATE FUNCTION rc_session_resolve(p_token_hash bytea)
RETURNS TABLE (session_id uuid, user_id uuid, clinic_id uuid, role text, is_super boolean,
               display_name text, email text, clinic_name text, clinic_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE sessions s SET last_seen_at = now()
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND s.last_seen_at < now() - interval '5 minutes';
  RETURN QUERY
  SELECT s.id, u.id, u.clinic_id, u.role, u.role = 'super_admin', u.display_name, u.email, cl.name, cl.status
  FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN clinics cl ON cl.id = u.clinic_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active';
END $$;

CREATE FUNCTION rc_session_revoke(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

-- Deactivating a user signs them out everywhere immediately.
CREATE FUNCTION rc_revoke_sessions_on_deactivate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'deactivated' AND OLD.status <> 'deactivated' THEN
    UPDATE sessions SET revoked_at = now() WHERE user_id = NEW.id AND revoked_at IS NULL;
    UPDATE auth_tokens SET used_at = now() WHERE user_id = NEW.id AND used_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_deactivate_sessions AFTER UPDATE OF status ON users
  FOR EACH ROW EXECUTE FUNCTION rc_revoke_sessions_on_deactivate();

-- ---------- password reset and staff invitations ----------
-- Forgot password: returns the user id (so the app can email them) or NULL for unknown/deactivated emails.
-- The app must show the same message either way.
CREATE FUNCTION rc_reset_token_create(p_email text, p_token_hash bytea, p_ttl interval)
RETURNS TABLE (user_id uuid, display_name text, email text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE lower(users.email) = lower(p_email) AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  -- only the newest reset link works
  UPDATE auth_tokens SET used_at = now() WHERE auth_tokens.user_id = u.id AND purpose = 'reset' AND used_at IS NULL;
  INSERT INTO auth_tokens(token_hash, user_id, purpose, expires_at) VALUES (p_token_hash, u.id, 'reset', now() + p_ttl);
  INSERT INTO audit_log(clinic_id, actor_user_id, actor_is_super, action, entity, entity_id)
  VALUES (u.clinic_id, u.id, u.role = 'super_admin', 'password_reset_requested', 'user', u.id::text);
  RETURN QUERY SELECT u.id, u.display_name, u.email;
END $$;

-- Staff invitation: called by the application inside the clinic admin's context. The caller must have
-- manage_staff in the invited user's clinic (or be super admin).
CREATE FUNCTION rc_invite_token_create(p_user uuid, p_token_hash bytea, p_ttl interval) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u users%ROWTYPE;
BEGIN
  SELECT * INTO u FROM users WHERE id = p_user;
  IF NOT FOUND OR u.status <> 'active' THEN RAISE EXCEPTION 'user not active'; END IF;
  IF NOT (rc_is_super() OR (u.clinic_id = rc_clinic_id() AND rc_has_capability('manage_staff'))) THEN
    RAISE EXCEPTION 'not allowed to invite this user';
  END IF;
  UPDATE auth_tokens SET used_at = now() WHERE user_id = u.id AND purpose = 'invite' AND used_at IS NULL;
  INSERT INTO auth_tokens(token_hash, user_id, purpose, expires_at) VALUES (p_token_hash, u.id, 'invite', now() + p_ttl);
  INSERT INTO audit_log(clinic_id, actor_user_id, actor_is_super, action, entity, entity_id)
  VALUES (u.clinic_id, rc_user_id(), rc_is_super(), 'staff_invited', 'user', u.id::text);
END $$;

-- Checks a reset/invite link without using it (to show the "choose a password" form).
CREATE FUNCTION rc_auth_token_peek(p_token_hash bytea)
RETURNS TABLE (purpose text, email text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.purpose, u.email, u.display_name FROM auth_tokens t JOIN users u ON u.id = t.user_id
  WHERE t.token_hash = p_token_hash AND t.used_at IS NULL AND t.expires_at > now() AND u.status = 'active'
$$;

-- Uses a reset/invite link: sets the new password, uses up the token and signs the user out everywhere.
-- Returns the user id, or NULL if the link is invalid, used or expired.
CREATE FUNCTION rc_auth_token_consume(p_token_hash bytea, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t auth_tokens%ROWTYPE; u users%ROWTYPE;
BEGIN
  SELECT * INTO t FROM auth_tokens WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO u FROM users WHERE id = t.user_id;
  IF u.status <> 'active' THEN RETURN NULL; END IF;
  UPDATE auth_tokens SET used_at = now() WHERE token_hash = p_token_hash;
  INSERT INTO user_credentials(user_id, password_hash) VALUES (u.id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now();
  UPDATE sessions SET revoked_at = now() WHERE user_id = u.id AND revoked_at IS NULL;
  DELETE FROM login_attempts WHERE lower(email) = lower(u.email);
  INSERT INTO audit_log(clinic_id, actor_user_id, actor_is_super, action, entity, entity_id)
  VALUES (u.clinic_id, u.id, u.role = 'super_admin',
          CASE t.purpose WHEN 'invite' THEN 'invite_accepted' ELSE 'password_reset' END, 'user', u.id::text);
  RETURN u.id;
END $$;

-- ---------- self-serve clinic signup ----------
-- Creates the clinic, its clinic admin, the admin's password and the terms acceptance in one step.
-- The Dental Pack (or the pack for the clinic type) is installed by the existing clinics trigger.
CREATE FUNCTION rc_signup_clinic(
  p_clinic_name text, p_clinic_type text, p_city text, p_phone text,
  p_admin_name text, p_admin_email text, p_password_hash text,
  p_terms_version text, p_terms_wording text, p_ip text)
RETURNS TABLE (clinic_id uuid, user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid; uid uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(p_admin_email)) THEN
    RAISE EXCEPTION 'email already registered' USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO clinics(name, clinic_type, city, phone) VALUES (p_clinic_name, p_clinic_type, p_city, p_phone)
  RETURNING id INTO cid;
  INSERT INTO users(clinic_id, role, email, display_name) VALUES (cid, 'clinic_admin', lower(p_admin_email), p_admin_name)
  RETURNING id INTO uid;
  INSERT INTO user_credentials(user_id, password_hash) VALUES (uid, p_password_hash);
  INSERT INTO terms_acceptances(clinic_id, user_id, terms_version, wording, ip)
  VALUES (cid, uid, p_terms_version, p_terms_wording, p_ip);
  INSERT INTO audit_log(clinic_id, actor_user_id, action, entity, entity_id, detail)
  VALUES (cid, uid, 'clinic_signup', 'clinic', cid::text, jsonb_build_object('terms_version', p_terms_version));
  RETURN QUERY SELECT cid, uid;
END $$;

-- ---------- grants ----------
REVOKE ALL ON FUNCTION rc_auth_lookup(text), rc_auth_recent_failures(text), rc_auth_record_attempt(text, text, boolean),
  rc_session_create(uuid, bytea, interval, text, text), rc_session_resolve(bytea), rc_session_revoke(bytea),
  rc_reset_token_create(text, bytea, interval), rc_invite_token_create(uuid, bytea, interval),
  rc_auth_token_peek(bytea), rc_auth_token_consume(bytea, text),
  rc_signup_clinic(text, text, text, text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_auth_lookup(text), rc_auth_recent_failures(text), rc_auth_record_attempt(text, text, boolean),
  rc_session_create(uuid, bytea, interval, text, text), rc_session_resolve(bytea), rc_session_revoke(bytea),
  rc_reset_token_create(text, bytea, interval), rc_invite_token_create(uuid, bytea, interval),
  rc_auth_token_peek(bytea), rc_auth_token_consume(bytea, text),
  rc_signup_clinic(text, text, text, text, text, text, text, text, text, text) TO rc_app;
