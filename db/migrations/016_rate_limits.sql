-- 016: Phase 8 hardening. Generic rate limits for public forms (signup, password reset), checked in the database
-- so they hold across several app servers.
CREATE TABLE rate_limit_hits (
  id bigserial PRIMARY KEY,
  bucket text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_bucket_at ON rate_limit_hits (bucket, at);
ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;   -- no policies: only the function below touches it

-- Records a hit and returns true if the bucket is still within its limit.
CREATE FUNCTION rc_rate_limit(p_bucket text, p_max int, p_window interval) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  DELETE FROM rate_limit_hits WHERE bucket = p_bucket AND at < now() - p_window;
  SELECT count(*) INTO n FROM rate_limit_hits WHERE bucket = p_bucket;
  IF n >= p_max THEN RETURN false; END IF;
  INSERT INTO rate_limit_hits (bucket) VALUES (p_bucket);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION rc_rate_limit(text, int, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rc_rate_limit(text, int, interval) TO rc_app;
