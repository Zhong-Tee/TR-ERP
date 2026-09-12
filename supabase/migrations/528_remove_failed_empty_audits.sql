-- Remove the four failed, empty Audit headers confirmed by the administrator.
-- Abort instead of deleting if the live rows no longer match the confirmed scope.

DO $$
DECLARE
  target_count integer;
  matched_count integer;
BEGIN
  SELECT COUNT(*)
  INTO target_count
  FROM public.inv_audits
  WHERE audit_no IN (
    'AUDIT-20260912-001',
    'AUDIT-20260911-003',
    'AUDIT-20260911-002',
    'AUDIT-20260911-001'
  );

  SELECT COUNT(*)
  INTO matched_count
  FROM public.inv_audits
  WHERE audit_no IN (
    'AUDIT-20260912-001',
    'AUDIT-20260911-003',
    'AUDIT-20260911-002',
    'AUDIT-20260911-001'
  )
    AND COALESCE(total_items, 0) = 0;

  -- A later migration replay is a no-op after the confirmed rows are gone.
  IF target_count = 0 THEN
    RETURN;
  END IF;

  IF target_count <> 4 OR matched_count <> 4 THEN
    RAISE EXCEPTION
      'Expected exactly 4 confirmed empty Audit headers, found % target rows / % empty rows; no rows deleted',
      target_count,
      matched_count;
  END IF;

  DELETE FROM public.inv_audits
  WHERE audit_no IN (
    'AUDIT-20260912-001',
    'AUDIT-20260911-003',
    'AUDIT-20260911-002',
    'AUDIT-20260911-001'
  )
    AND COALESCE(total_items, 0) = 0;
END;
$$;
