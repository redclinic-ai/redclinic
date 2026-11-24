-- Demo requests from the marketing website. Run once in the database used for leads
-- (for example a Supabase project). Kept separate from the clinic application's migrations:
-- these are prospects, not clinic or patient data.

CREATE TABLE IF NOT EXISTS demo_requests (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reference     text NOT NULL UNIQUE CHECK (reference ~ '^RC-[0-9A-Z]{8}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  phone         text NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  clinic        text NOT NULL CHECK (char_length(clinic) BETWEEN 2 AND 120),
  city          text NOT NULL CHECK (char_length(city) BETWEEN 2 AND 60),
  clinic_size   text CHECK (clinic_size IN ('1','2-3','4+','multi')),
  speciality    text CHECK (speciality IN ('dental','skin','physio','ent','eye','gynae','paediatrics','general','diagnostics','other')),
  plan          text CHECK (plan IN ('pilot','clinic','multi')),
  call_time     text CHECK (call_time IN ('morning','afternoon','evening')),
  landing_page  text,
  referrer      text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_term      text,
  utm_content   text,
  click_id      text,
  device        text CHECK (device IN ('mobile','tablet','desktop')),
  ip            text,
  -- Sales follow-up, updated by the RedClinic team
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','contacted','demo_booked','demo_done','no_show','trial','won','lost','spam')),
  demo_at       timestamptz,
  notes         text,
  deleted_at    timestamptz
);

CREATE INDEX IF NOT EXISTS demo_requests_created_idx ON demo_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS demo_requests_status_idx ON demo_requests (status);

-- Lock the table down: no public access through the REST API. The website server inserts with
-- the service role key, which bypasses row-level security. Nobody else gets a policy.
ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON demo_requests FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON demo_requests FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON demo_requests FROM authenticated'; END IF;
END $$;

-- Funnel view: requests to paying clinics, by landing page and source.
CREATE OR REPLACE VIEW demo_funnel AS
SELECT coalesce(landing_page, '(unknown)') AS landing_page,
       coalesce(nullif(utm_source, ''), CASE WHEN referrer IS NOT NULL THEN 'referral' ELSE 'direct' END) AS source,
       coalesce(plan, '(none)') AS plan,
       count(*) FILTER (WHERE status <> 'spam')                                        AS requests,
       count(*) FILTER (WHERE status IN ('demo_booked','demo_done','trial','won'))      AS demos_booked,
       count(*) FILTER (WHERE status IN ('demo_done','trial','won'))                    AS demos_attended,
       count(*) FILTER (WHERE status IN ('trial','won'))                                AS trials,
       count(*) FILTER (WHERE status = 'won')                                           AS paying_clinics
FROM demo_requests WHERE deleted_at IS NULL
GROUP BY 1, 2, 3;

ALTER VIEW demo_funnel SET (security_invoker = true);
REVOKE ALL ON demo_funnel FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON demo_funnel FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON demo_funnel FROM authenticated'; END IF;
END $$;
