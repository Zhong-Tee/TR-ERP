-- Apply the latest shipping-option rules to existing Marketplace work and billed orders.
BEGIN;

CREATE OR REPLACE FUNCTION rpc_backfill_mp_shipping_labels(p_config_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mp_count INTEGER := 0;
  v_bill_count INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM us_users
    WHERE id = auth.uid()
      AND role IN ('superadmin', 'admin')
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อัปเดตป้าย Marketplace';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM mp_channel_configs WHERE id = p_config_id) THEN
    RAISE EXCEPTION 'ไม่พบการตั้งค่า Marketplace';
  END IF;

  -- Clear values first so removed/changed rules do not leave stale labels behind.
  UPDATE mp_orders
  SET shipping_option = NULL,
      urgency_label = NULL
  WHERE config_id = p_config_id;

  WITH matched AS (
    SELECT DISTINCT ON (o.id)
      o.id,
      snapshot.value AS shipping_option,
      NULLIF(BTRIM(rule.item->>'label'), '') AS urgency_label
    FROM mp_orders o
    JOIN mp_channel_configs cfg ON cfg.id = o.config_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(cfg.shipping_rules, '[]'::jsonb))
      WITH ORDINALITY AS rule(item, position)
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(o.raw_snapshot, '{}'::jsonb)) AS snapshot(key, value)
    WHERE o.config_id = p_config_id
      AND (
        (COALESCE(rule.item->>'source_type', 'header_exact') = 'header_exact'
          AND LOWER(BTRIM(snapshot.key)) = LOWER(BTRIM(rule.item->>'source_value')))
        OR
        (rule.item->>'source_type' = 'header_contains'
          AND STRPOS(LOWER(snapshot.key), LOWER(BTRIM(rule.item->>'source_value'))) > 0)
      )
      AND NULLIF(BTRIM(rule.item->>'match_value'), '') IS NOT NULL
      AND (
        (COALESCE(rule.item->>'match_type', 'exact') = 'exact'
          AND LOWER(BTRIM(snapshot.value)) = LOWER(BTRIM(rule.item->>'match_value')))
        OR
        (rule.item->>'match_type' = 'contains'
          AND STRPOS(LOWER(snapshot.value), LOWER(BTRIM(rule.item->>'match_value'))) > 0)
      )
    ORDER BY o.id, rule.position
  )
  UPDATE mp_orders o
  SET shipping_option = matched.shipping_option,
      urgency_label = matched.urgency_label
  FROM matched
  WHERE o.id = matched.id;

  GET DIAGNOSTICS v_mp_count = ROW_COUNT;

  -- Keep already-issued bills intact: only copy label metadata, never channel or bill number.
  UPDATE or_orders billed
  SET shipping_option = source.shipping_option,
      urgency_label = source.urgency_label
  FROM mp_orders source
  WHERE source.config_id = p_config_id
    AND source.billed_order_id = billed.id;

  GET DIAGNOSTICS v_bill_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'marketplace_orders', v_mp_count,
    'billed_orders', v_bill_count
  );
END;
$$;

REVOKE ALL ON FUNCTION rpc_backfill_mp_shipping_labels(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_backfill_mp_shipping_labels(UUID) TO authenticated;

COMMIT;
