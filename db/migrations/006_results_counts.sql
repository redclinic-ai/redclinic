-- 006: Results dashboard counts. Counts only: no money, no patient names (decision D5, master prompt section 15).
-- Simulated calls and appointments are excluded unless explicitly asked for (decision D9).

CREATE FUNCTION rc_results_counts(p_from timestamptz, p_to timestamptz, p_include_simulated boolean DEFAULT false)
RETURNS TABLE (metric text, value bigint)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT (rc_is_super() OR rc_has_capability('view_results')) THEN
    RAISE EXCEPTION 'view_results permission required';
  END IF;
  RETURN QUERY
  WITH c AS (
    SELECT * FROM calls
    WHERE started_at >= p_from AND started_at < p_to AND (p_include_simulated OR NOT is_simulated)
      AND (rc_is_super() OR clinic_id = rc_clinic_id())
  ), a AS (
    SELECT * FROM appointments
    WHERE starts_at >= p_from AND starts_at < p_to AND (rc_is_super() OR clinic_id = rc_clinic_id())
  )
  SELECT 'calls_total', count(*) FROM c
  UNION ALL SELECT 'calls_handled_by_nepa', count(*) FROM c WHERE handled_by_nepa AND NOT handed_to_staff
  UNION ALL SELECT 'calls_handed_to_staff', count(*) FROM c WHERE handed_to_staff
  UNION ALL SELECT 'calls_missed', count(*) FROM c WHERE status = 'missed'
  UNION ALL SELECT 'appointments_total', count(*) FROM a
  UNION ALL SELECT 'appointments_booked_by_nepa', count(*) FROM a WHERE booked_via = 'nepa'
  UNION ALL SELECT 'appointments_completed', count(*) FROM a WHERE status = 'completed'
  UNION ALL SELECT 'appointments_no_show', count(*) FROM a WHERE status = 'no_show'
  UNION ALL SELECT 'appointments_cancelled', count(*) FROM a WHERE status = 'cancelled'
  UNION ALL SELECT 'new_patients', count(*) FROM patients
    WHERE registered_at >= p_from AND registered_at < p_to AND (rc_is_super() OR clinic_id = rc_clinic_id());
END $$;
GRANT EXECUTE ON FUNCTION rc_results_counts(timestamptz, timestamptz, boolean) TO rc_app;
