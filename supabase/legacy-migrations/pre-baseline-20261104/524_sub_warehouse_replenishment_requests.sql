-- Sub-warehouse operational balance and replenishment requests.
-- The sub-warehouse is a production control ledger only: work orders consume
-- its balance; WMS requisitions and unclassified WMS rows remain informational.

BEGIN;

CREATE OR REPLACE FUNCTION public.can_manage_sub_warehouse_stock()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users app_user
    WHERE app_user.id = auth.uid()
      AND app_user.is_active IS DISTINCT FROM false
      AND app_user.role IN ('superadmin', 'admin', 'store')
  ) OR public.is_current_wms_store_backup();
$$;

CREATE OR REPLACE FUNCTION public.can_request_sub_warehouse_stock()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT public.is_current_wms_store_backup()
    AND EXISTS (
      SELECT 1
      FROM public.us_users app_user
      WHERE app_user.id = auth.uid()
        AND app_user.is_active IS DISTINCT FROM false
        AND app_user.role IN ('production', 'qc_staff', 'packing_staff')
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_sub_warehouse_stock() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_request_sub_warehouse_stock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_sub_warehouse_stock() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_request_sub_warehouse_stock() TO authenticated;

CREATE TABLE IF NOT EXISTS public.wh_sub_warehouse_replenishment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sub_warehouse_id UUID NOT NULL REFERENCES public.wh_sub_warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  requested_qty NUMERIC NOT NULL CHECK (requested_qty > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  requested_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  fulfilled_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_sub_replenishment_pending_requester_product
  ON public.wh_sub_warehouse_replenishment_requests (sub_warehouse_id, product_id, requested_by)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_wh_sub_replenishment_pending_warehouse
  ON public.wh_sub_warehouse_replenishment_requests (sub_warehouse_id, status, created_at);

-- Include requests in annual/go-live transactional cleanup without rewriting
-- the already-applied reset migration.
CREATE OR REPLACE FUNCTION public.erp_data_tables_for_operation(p_operation_type TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (
    CASE
      WHEN p_operation_type = 'go_live_reset' THEN public.erp_data_go_live_tables()
      ELSE public.erp_data_transactional_tables()
    END
  ) || ARRAY['wh_sub_warehouse_replenishment_requests']::TEXT[];
$$;

ALTER TABLE public.wh_sub_warehouse_replenishment_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.wh_sub_warehouse_replenishment_requests TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wh_sub_warehouse_replenishment_requests FROM authenticated;

DROP POLICY IF EXISTS "Sub warehouse requests readable" ON public.wh_sub_warehouse_replenishment_requests;
CREATE POLICY "Sub warehouse requests readable"
  ON public.wh_sub_warehouse_replenishment_requests FOR SELECT TO authenticated
  USING (
    requested_by = auth.uid()
    OR public.can_manage_sub_warehouse_stock()
  );

ALTER TABLE public.wh_sub_warehouse_stock_moves
  ADD COLUMN IF NOT EXISTS replenishment_request_id UUID
    REFERENCES public.wh_sub_warehouse_replenishment_requests(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wh_sub_stock_move_replenishment_request
  ON public.wh_sub_warehouse_stock_moves (replenishment_request_id)
  WHERE replenishment_request_id IS NOT NULL;

-- Only actual Store-capable users may mutate the note ledger. UI checks are
-- mirrored here so direct API calls cannot bypass the role rule.
DROP POLICY IF EXISTS "Desktop roles can manage sub warehouse stock moves" ON public.wh_sub_warehouse_stock_moves;
CREATE POLICY "Store-capable users can manage sub warehouse stock moves"
  ON public.wh_sub_warehouse_stock_moves FOR ALL TO authenticated
  USING (public.can_manage_sub_warehouse_stock())
  WITH CHECK (public.can_manage_sub_warehouse_stock());

CREATE OR REPLACE FUNCTION public.rpc_set_sub_warehouse_replenishment_request(
  p_sub_warehouse_id UUID,
  p_product_id UUID,
  p_requested_qty NUMERIC
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request_id UUID;
BEGIN
  IF NOT public.can_request_sub_warehouse_stock() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ขอเบิกสินค้าคลังย่อย';
  END IF;
  IF p_requested_qty IS NULL OR p_requested_qty <= 0 THEN
    RAISE EXCEPTION 'จำนวนที่ขอเบิกต้องมากกว่า 0';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.wh_sub_warehouses warehouse
    WHERE warehouse.id = p_sub_warehouse_id AND warehouse.is_active = true
  ) OR NOT EXISTS (
    SELECT 1 FROM public.wh_sub_warehouse_products assigned
    WHERE assigned.sub_warehouse_id = p_sub_warehouse_id
      AND assigned.product_id = p_product_id
  ) THEN
    RAISE EXCEPTION 'ไม่พบสินค้านี้ในคลังย่อยที่เลือก';
  END IF;

  INSERT INTO public.wh_sub_warehouse_replenishment_requests (
    sub_warehouse_id, product_id, requested_qty, requested_by
  ) VALUES (
    p_sub_warehouse_id, p_product_id, p_requested_qty, auth.uid()
  )
  ON CONFLICT (sub_warehouse_id, product_id, requested_by)
    WHERE status = 'pending'
  DO UPDATE SET
    requested_qty = EXCLUDED.requested_qty,
    updated_at = NOW()
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_sub_warehouse_replenishment_request(
  p_request_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.can_request_sub_warehouse_stock() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยกเลิกคำขอเบิกสินค้าคลังย่อย';
  END IF;

  UPDATE public.wh_sub_warehouse_replenishment_requests
  SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
  WHERE id = p_request_id
    AND requested_by = auth.uid()
    AND status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบคำขอที่แก้ไขได้ หรือคำขอนี้ถูกดำเนินการแล้ว';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_fulfill_sub_warehouse_replenishment_request(
  p_request_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_request public.wh_sub_warehouse_replenishment_requests%ROWTYPE;
  v_requester_name TEXT;
  v_move_id UUID;
BEGIN
  IF NOT public.can_manage_sub_warehouse_stock() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันเติมสต๊อคคลังย่อย';
  END IF;

  SELECT * INTO v_request
  FROM public.wh_sub_warehouse_replenishment_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'ไม่พบคำขอเบิก';
  END IF;
  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'คำขอนี้ถูกดำเนินการแล้ว';
  END IF;

  SELECT COALESCE(NULLIF(BTRIM(username), ''), NULLIF(BTRIM(email), ''), v_request.requested_by::TEXT)
  INTO v_requester_name
  FROM public.us_users
  WHERE id = v_request.requested_by;

  INSERT INTO public.wh_sub_warehouse_stock_moves (
    sub_warehouse_id, product_id, qty_delta, reason, note, created_by,
    replenishment_request_id
  ) VALUES (
    v_request.sub_warehouse_id,
    v_request.product_id,
    v_request.requested_qty,
    'เติมสต๊อคตามคำขอ',
    'คำขอของ ' || COALESCE(v_requester_name, v_request.requested_by::TEXT),
    auth.uid(),
    v_request.id
  )
  RETURNING id INTO v_move_id;

  UPDATE public.wh_sub_warehouse_replenishment_requests
  SET status = 'fulfilled', fulfilled_by = auth.uid(), fulfilled_at = NOW(), updated_at = NOW()
  WHERE id = v_request.id;

  RETURN v_move_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_set_sub_warehouse_replenishment_request(UUID, UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cancel_sub_warehouse_replenishment_request(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_fulfill_sub_warehouse_replenishment_request(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_set_sub_warehouse_replenishment_request(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sub_warehouse_replenishment_request(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_fulfill_sub_warehouse_replenishment_request(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.rpc_get_sub_warehouse_replenishment_requests(UUID);
CREATE FUNCTION public.rpc_get_sub_warehouse_replenishment_requests(
  p_sub_warehouse_id UUID
) RETURNS TABLE (
  id UUID,
  sub_warehouse_id UUID,
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  requested_qty NUMERIC,
  status TEXT,
  requested_by UUID,
  requester_name TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    request.id,
    request.sub_warehouse_id,
    request.product_id,
    product.product_code,
    product.product_name,
    product.unit_name,
    request.requested_qty,
    request.status,
    request.requested_by,
    COALESCE(NULLIF(BTRIM(requester.username), ''), NULLIF(BTRIM(requester.email), ''), request.requested_by::TEXT),
    request.created_at,
    request.updated_at
  FROM public.wh_sub_warehouse_replenishment_requests request
  JOIN public.pr_products product ON product.id = request.product_id
  LEFT JOIN public.us_users requester ON requester.id = request.requested_by
  WHERE request.sub_warehouse_id = p_sub_warehouse_id
    AND request.status = 'pending'
    AND (
      public.can_manage_sub_warehouse_stock()
      OR (public.can_request_sub_warehouse_stock() AND request.requested_by = auth.uid())
    )
  ORDER BY request.created_at, request.id;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sub_warehouse_replenishment_requests(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_replenishment_requests(UUID) TO authenticated;

-- Include the actor's display name in the stock-movement audit report.
DROP FUNCTION IF EXISTS public.rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT);
CREATE FUNCTION public.rpc_get_sub_warehouse_moves(
  p_sub_warehouse_id UUID,
  p_date_from DATE,
  p_date_to DATE,
  p_product_code TEXT DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  created_by UUID,
  created_by_name TEXT,
  product_id UUID,
  product_code TEXT,
  product_name TEXT,
  unit_name TEXT,
  qty_delta NUMERIC,
  reason TEXT,
  note TEXT,
  balance_after NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(EXTRACT(YEAR FROM p_date_from)::INT, EXTRACT(MONTH FROM p_date_from)::INT,
        EXTRACT(DAY FROM p_date_from)::INT, 0, 0, 0, 'Asia/Bangkok') AS range_start,
      make_timestamptz(EXTRACT(YEAR FROM p_date_to)::INT, EXTRACT(MONTH FROM p_date_to)::INT,
        EXTRACT(DAY FROM p_date_to)::INT, 0, 0, 0, 'Asia/Bangkok') + INTERVAL '1 day' AS range_end_excl
  ), ranked AS (
    SELECT movement.*, product.product_code, product.product_name, product.unit_name,
      COALESCE(NULLIF(BTRIM(actor.username), ''), NULLIF(BTRIM(actor.email), ''), movement.created_by::TEXT) AS actor_name,
      SUM(movement.qty_delta) OVER (
        PARTITION BY movement.product_id
        ORDER BY movement.created_at, movement.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS running_balance
    FROM public.wh_sub_warehouse_stock_moves movement
    JOIN public.pr_products product ON product.id = movement.product_id
    LEFT JOIN public.us_users actor ON actor.id = movement.created_by
    WHERE movement.sub_warehouse_id = p_sub_warehouse_id
  )
  SELECT ranked.id, ranked.created_at, ranked.created_by, ranked.actor_name,
    ranked.product_id, ranked.product_code, ranked.product_name, ranked.unit_name,
    ranked.qty_delta, ranked.reason, ranked.note, ranked.running_balance
  FROM ranked CROSS JOIN bounds
  WHERE ranked.created_at >= bounds.range_start
    AND ranked.created_at < bounds.range_end_excl
    AND (
      p_product_code IS NULL OR BTRIM(p_product_code) = ''
      OR ranked.product_code ILIKE ('%' || BTRIM(p_product_code) || '%')
      OR ranked.product_name ILIKE ('%' || BTRIM(p_product_code) || '%')
    )
  ORDER BY ranked.created_at DESC, ranked.id DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_moves(UUID, DATE, DATE, TEXT) TO authenticated;

-- Rebuild the daily balance so only work-order usage consumes the production
-- control balance. Requisitions and other WMS rows remain in the breakdown RPC.
CREATE OR REPLACE FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(
  p_sub_warehouse_id UUID, p_date DATE
) RETURNS TABLE(
  product_id UUID, product_code TEXT, product_name TEXT, unit_name TEXT,
  received_opening NUMERIC, replenish_day NUMERIC, reduce_day NUMERIC,
  wms_opening NUMERIC, wms_day NUMERIC, balance_opening NUMERIC, balance_eod NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH bounds AS (
    SELECT
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok') AS day_start,
      make_timestamptz(EXTRACT(YEAR FROM p_date)::INT,EXTRACT(MONTH FROM p_date)::INT,
        EXTRACT(DAY FROM p_date)::INT,0,0,0,'Asia/Bangkok')+INTERVAL '1 day' AS day_end_excl
  ), groups_scope AS (
    SELECT map_group.id FROM public.wh_sub_wms_map_groups map_group
    WHERE map_group.sub_warehouse_id IS NULL OR map_group.sub_warehouse_id=p_sub_warehouse_id
  ), wms_usage AS (
    SELECT wms.product_code,wms.qty,
      COALESCE(summary.checked_at,
        CASE WHEN wms.fulfillment_mode IN ('system_complete','sub_warehouse_skip') THEN wms.end_time END
      ) AS used_at,
      CASE
        WHEN requisition.id IS NOT NULL OR UPPER(BTRIM(COALESCE(wms.order_id,''))) LIKE 'REQ-%' THEN 'requisition'
        WHEN wms.work_order_id IS NOT NULL OR EXISTS (
          SELECT 1 FROM public.or_orders sales_order
          WHERE BTRIM(COALESCE(sales_order.work_order_name,''))=BTRIM(COALESCE(wms.order_id,''))
        ) THEN 'work_order'
        ELSE 'other'
      END AS usage_source
    FROM public.wms_orders wms
    LEFT JOIN public.wms_requisitions requisition ON requisition.requisition_id=wms.order_id
    LEFT JOIN LATERAL (
      SELECT wms_summary.checked_at FROM public.wms_order_summaries wms_summary
      WHERE wms_summary.order_id=wms.order_id ORDER BY wms_summary.checked_at LIMIT 1
    ) summary ON TRUE
    WHERE wms.status='correct'
  ), group_wms_open AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY source.group_id
  ), group_wms_day AS (
    SELECT source.group_id,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM public.wh_sub_wms_map_sources source
    JOIN groups_scope ON groups_scope.id=source.group_id
    JOIN public.pr_products product_source ON product_source.id=source.product_id
    JOIN wms_usage usage ON usage.product_code::TEXT=product_source.product_code::TEXT
    CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY source.group_id
  ), spare_group AS (
    SELECT spare.product_id,spare.group_id FROM public.wh_sub_wms_map_spares spare
    JOIN groups_scope ON groups_scope.id=spare.group_id
  ), products AS (
    SELECT assigned.product_id,product.product_code,product.product_name,product.unit_name
    FROM public.wh_sub_warehouse_products assigned
    JOIN public.pr_products product ON product.id=assigned.product_id
    WHERE assigned.sub_warehouse_id=p_sub_warehouse_id
  ), recv_open AS (
    SELECT movement.product_id,COALESCE(SUM(movement.qty_delta),0)::NUMERIC qty
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id AND movement.created_at<bounds.day_start
    GROUP BY movement.product_id
  ), recv_day AS (
    SELECT movement.product_id,
      COALESCE(SUM(CASE WHEN movement.qty_delta>0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC replenish,
      COALESCE(SUM(CASE WHEN movement.qty_delta<0 THEN movement.qty_delta ELSE 0 END),0)::NUMERIC reduce_sum
    FROM public.wh_sub_warehouse_stock_moves movement CROSS JOIN bounds
    WHERE movement.sub_warehouse_id=p_sub_warehouse_id
      AND movement.created_at>=bounds.day_start AND movement.created_at<bounds.day_end_excl
    GROUP BY movement.product_id
  ), wms_open AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order' AND usage.used_at<bounds.day_start
    GROUP BY usage.product_code
  ), wms_day_tbl AS (
    SELECT usage.product_code::TEXT,COALESCE(SUM(usage.qty),0)::NUMERIC qty
    FROM wms_usage usage CROSS JOIN bounds
    WHERE usage.usage_source='work_order'
      AND usage.used_at>=bounds.day_start AND usage.used_at<bounds.day_end_excl
    GROUP BY usage.product_code
  )
  SELECT product_row.product_id,product_row.product_code,product_row.product_name,product_row.unit_name,
    COALESCE(recv_open.qty,0)::NUMERIC,COALESCE(recv_day.replenish,0)::NUMERIC,
    COALESCE(recv_day.reduce_sum,0)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    (CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END)::NUMERIC,
    (COALESCE(recv_open.qty,0)-CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)::NUMERIC,
    ((COALESCE(recv_open.qty,0)+COALESCE(recv_day.replenish,0)+COALESCE(recv_day.reduce_sum,0))
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_open.qty,0) ELSE COALESCE(wms_open.qty,0) END)
      -(CASE WHEN spare_group.group_id IS NOT NULL THEN COALESCE(group_day.qty,0) ELSE COALESCE(wms_day.qty,0) END))::NUMERIC
  FROM products product_row
  LEFT JOIN spare_group ON spare_group.product_id=product_row.product_id
  LEFT JOIN group_wms_open group_open ON group_open.group_id=spare_group.group_id
  LEFT JOIN group_wms_day group_day ON group_day.group_id=spare_group.group_id
  LEFT JOIN recv_open ON recv_open.product_id=product_row.product_id
  LEFT JOIN recv_day ON recv_day.product_id=product_row.product_id
  LEFT JOIN wms_open ON wms_open.product_code=product_row.product_code
  LEFT JOIN wms_day_tbl wms_day ON wms_day.product_code=product_row.product_code
  ORDER BY product_row.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_sub_warehouse_daily_stock_sheet(UUID,DATE) TO authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wh_sub_warehouse_replenishment_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
