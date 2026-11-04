-- Exclude legacy tables that no longer exist from backup/reset scope.
-- A missing table contains no data to back up; actual export failures for
-- existing tables must still fail the Go-live backup.

CREATE OR REPLACE FUNCTION public.erp_data_tables_for_operation(p_operation_type TEXT)
RETURNS TEXT[]
LANGUAGE SQL
STABLE
SET search_path = public
AS $$
  WITH requested_tables AS (
    SELECT table_name, ordinal_position
    FROM unnest(
      CASE
        WHEN p_operation_type = 'go_live_reset' THEN public.erp_data_go_live_tables()
        ELSE public.erp_data_transactional_tables()
      END
    ) WITH ORDINALITY AS requested(table_name, ordinal_position)
  )
  SELECT COALESCE(
    array_agg(table_name ORDER BY ordinal_position),
    ARRAY[]::TEXT[]
  )
  FROM requested_tables
  WHERE to_regclass('public.' || quote_ident(table_name)) IS NOT NULL;
$$;

COMMENT ON FUNCTION public.erp_data_tables_for_operation(TEXT) IS
  'Returns only currently existing public transaction tables for backup/reset operations.';

NOTIFY pgrst, 'reload schema';
