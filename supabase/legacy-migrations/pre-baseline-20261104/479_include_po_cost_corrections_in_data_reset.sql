-- PO cost-correction history is transactional purchase data and has RESTRICT
-- foreign keys to inv_po / inv_po_items. Include it in reset scope so the
-- dependency-aware delete can remove the audit children before their PO rows.

CREATE OR REPLACE FUNCTION public.erp_data_tables_for_operation(p_operation_type TEXT)
RETURNS TEXT[]
LANGUAGE SQL
STABLE
SET search_path = public
AS $$
  WITH requested_tables AS (
    SELECT table_name, ordinal_position
    FROM unnest(
      (
        CASE
          WHEN p_operation_type = 'go_live_reset' THEN public.erp_data_go_live_tables()
          ELSE public.erp_data_transactional_tables()
        END
      ) || ARRAY[
        'inv_po_cost_correction_items',
        'inv_po_cost_corrections'
      ]::TEXT[]
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
  'Returns existing transaction tables, including PO cost-correction audit children, for backup/reset operations.';

NOTIFY pgrst, 'reload schema';
