BEGIN;

-- A WMS row may be moved away from "correct" and checked again.  The old
-- trigger treated that as a new deduction even when a pick movement already
-- existed.  Deduct only the outstanding quantity for the row.
CREATE OR REPLACE FUNCTION public.inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id UUID;
  v_product_code TEXT;
  v_product_name TEXT;
  v_movement_id UUID;
  v_stock_qty NUMERIC;
  v_already_deducted NUMERIC := 0;
  v_deduct_qty NUMERIC := 0;
  v_on_hand NUMERIC := 0;
  v_reserved NUMERIC := 0;
  v_available_for_row NUMERIC := 0;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT p.id, p.product_code, p.product_name
  INTO v_product_id, v_product_code, v_product_name
  FROM public.pr_products p
  WHERE p.product_code = NEW.product_code
  LIMIT 1;

  IF v_product_id IS NULL THEN RETURN NEW; END IF;
  v_stock_qty := COALESCE(NEW.qty, 0);

  IF NEW.status = 'picked'
     AND (OLD.status IS NULL OR OLD.status NOT IN ('picked', 'correct'))
  THEN
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, v_stock_qty, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET reserved = COALESCE(public.inv_stock_balances.reserved, 0) + v_stock_qty,
          updated_at = NOW();
  END IF;

  IF NEW.status = 'correct'
     AND (OLD.status IS NULL OR OLD.status <> 'correct')
  THEN
    SELECT COALESCE(SUM(-m.qty) FILTER (
      WHERE m.movement_type IN ('pick', 'pick_reversal')
    ), 0)
    INTO v_already_deducted
    FROM public.inv_stock_movements m
    WHERE m.ref_type = 'wms_orders' AND m.ref_id = NEW.id;

    v_deduct_qty := GREATEST(v_stock_qty - v_already_deducted, 0);

    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, 0, 0, 0)
    ON CONFLICT (product_id) DO NOTHING;

    SELECT COALESCE(b.on_hand, 0), COALESCE(b.reserved, 0)
    INTO v_on_hand, v_reserved
    FROM public.inv_stock_balances b
    WHERE b.product_id = v_product_id
    FOR UPDATE;

    v_available_for_row := v_on_hand - v_reserved
      + CASE WHEN OLD.status = 'picked' THEN v_stock_qty ELSE 0 END;
    IF v_available_for_row < v_deduct_qty THEN
      RAISE EXCEPTION 'สต๊อกพร้อมตัดของสินค้า % - % ไม่เพียงพอ ขาด % %',
        COALESCE(NULLIF(v_product_code, ''), v_product_id::TEXT),
        COALESCE(NULLIF(v_product_name, ''), NEW.product_name, '-'),
        v_deduct_qty - v_available_for_row,
        COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'หน่วย');
    END IF;

    IF v_deduct_qty > 0 THEN
      PERFORM public.fn_reconcile_sellable_lots_to_on_hand(v_product_id);

      INSERT INTO public.inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note
      ) VALUES (
        v_product_id, 'pick', -v_deduct_qty, 'wms_orders', NEW.id,
        'ตัดสต๊อกตามหน่วยสินค้า ' || COALESCE(NULLIF(BTRIM(NEW.unit_name), ''), 'ชิ้น')
      ) RETURNING id INTO v_movement_id;

      PERFORM public.fn_consume_stock_fifo(v_product_id, v_deduct_qty, v_movement_id);

      UPDATE public.inv_stock_balances
      SET on_hand = COALESCE(on_hand, 0) - v_deduct_qty,
          reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;

      PERFORM public.fn_recalc_product_landed_cost(v_product_id);
    ELSIF OLD.status = 'picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
    END IF;
  END IF;

  IF NEW.status = 'out_of_stock' AND OLD.status = 'picked' THEN
    UPDATE public.inv_stock_balances
    SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
        updated_at = NOW()
    WHERE product_id = v_product_id;
  END IF;

  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    IF OLD.status = 'picked' THEN
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_stock_qty, 0),
          updated_at = NOW()
      WHERE product_id = v_product_id;
    ELSIF OLD.status = 'correct' THEN
      PERFORM public.fn_reverse_wms_stock(NEW.id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Keep true legacy rows separate from a normal linked movement mismatch so the
-- anomaly screen can explain the problem accurately.
CREATE OR REPLACE FUNCTION public.fn_wms_item_has_unlinked_legacy_conflict(p_order_item_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.or_order_items oi
    JOIN public.or_orders o ON o.id=oi.order_id
    JOIN public.pr_products p ON p.id=oi.product_id
    JOIN public.wms_orders w ON w.source_order_item_id IS NULL
      AND UPPER(BTRIM(COALESCE(w.product_code,'')))=UPPER(BTRIM(COALESCE(p.product_code::TEXT,'')))
      AND (w.work_order_id=o.work_order_id OR w.source_order_id=o.id OR
        (w.work_order_id IS NULL AND BTRIM(COALESCE(w.order_id,''))=BTRIM(COALESCE(o.work_order_name,''))))
    WHERE oi.id=p_order_item_id
      AND (
        w.status<>'cancelled'
        OR EXISTS (
          SELECT 1 FROM public.inv_stock_movements m
          WHERE m.ref_type='wms_orders' AND m.ref_id=w.id
          GROUP BY m.ref_id HAVING COALESCE(SUM(-m.qty) FILTER
            (WHERE m.movement_type IN ('pick','pick_reversal')),0)<>0
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.fn_wms_item_has_unlinked_legacy_conflict(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_item_has_unlinked_legacy_conflict(UUID) TO authenticated,service_role;

CREATE TABLE IF NOT EXISTS public.wms_stock_repair_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES public.or_order_items(id),
  product_id UUID NOT NULL REFERENCES public.pr_products(id),
  repaired_qty NUMERIC NOT NULL CHECK (repaired_qty > 0),
  reason TEXT NOT NULL,
  repaired_by UUID REFERENCES public.us_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.wms_stock_repair_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "WMS stock repair audit read" ON public.wms_stock_repair_audit;
CREATE POLICY "WMS stock repair audit read" ON public.wms_stock_repair_audit
FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid() AND u.role IN ('superadmin','admin','store','manager'))
);

CREATE OR REPLACE FUNCTION public.rpc_repair_wms_excess_deduction(
  p_order_item_id UUID,
  p_reason TEXT DEFAULT 'Repair excess WMS stock deduction from anomaly screen'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT;
  v_product_id UUID;
  v_expected NUMERIC := 0;
  v_wms_qty NUMERIC := 0;
  v_correct NUMERIC := 0;
  v_deducted NUMERIC := 0;
  v_excess NUMERIC := 0;
  v_remaining NUMERIC := 0;
  v_restore NUMERIC := 0;
  v_restored_cost NUMERIC := 0;
  v_ref_id UUID;
  v_cons RECORD;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS DISTINCT FROM 'superadmin' THEN
    RAISE EXCEPTION 'Only superadmin can repair an excess stock deduction';
  END IF;
  IF LENGTH(BTRIM(COALESCE(p_reason,''))) < 3 THEN
    RAISE EXCEPTION 'A repair reason is required';
  END IF;

  SELECT oi.product_id, COALESCE(oi.quantity,1)
  INTO v_product_id, v_expected
  FROM public.or_order_items oi
  WHERE oi.id=p_order_item_id
  FOR UPDATE;
  IF v_product_id IS NULL THEN RAISE EXCEPTION 'Order item not found'; END IF;

  PERFORM 1 FROM public.wms_orders w
  WHERE w.source_order_item_id=p_order_item_id FOR UPDATE;

  IF public.fn_wms_item_has_unlinked_legacy_conflict(p_order_item_id) THEN
    RAISE EXCEPTION 'Unlinked legacy WMS rows must be reviewed manually';
  END IF;

  SELECT COALESCE(SUM(w.qty) FILTER (WHERE w.status<>'cancelled'),0),
         COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0),
         (ARRAY_AGG(w.id ORDER BY w.created_at,w.id) FILTER (WHERE w.status='correct'))[1]
  INTO v_wms_qty,v_correct,v_ref_id
  FROM public.wms_orders w WHERE w.source_order_item_id=p_order_item_id;

  SELECT COALESCE(SUM(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')),0)
  INTO v_deducted
  FROM public.wms_orders w
  JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
  WHERE w.source_order_item_id=p_order_item_id;

  IF v_wms_qty<>v_expected OR v_correct<>v_expected THEN
    RAISE EXCEPTION 'WMS quantities must match the sold quantity before repairing stock';
  END IF;
  IF v_deducted<=v_correct THEN
    RAISE EXCEPTION 'No excess stock deduction was found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
    WHERE w.source_order_item_id=p_order_item_id AND m.movement_type='pick_reversal'
  ) THEN
    RAISE EXCEPTION 'Existing reversals require manual review';
  END IF;

  v_excess := v_deducted-v_correct;
  v_remaining := v_excess;

  FOR v_cons IN
    SELECT lc.id,lc.lot_id,lc.qty,lc.unit_cost
    FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id AND m.movement_type='pick'
    JOIN public.inv_lot_consumptions lc ON lc.movement_id=m.id
    WHERE w.source_order_item_id=p_order_item_id
    ORDER BY m.created_at DESC,lc.created_at DESC
    FOR UPDATE OF lc
  LOOP
    EXIT WHEN v_remaining<=0;
    v_restore:=LEAST(v_cons.qty,v_remaining);
    UPDATE public.inv_stock_lots SET qty_remaining=qty_remaining+v_restore WHERE id=v_cons.lot_id;
    IF v_restore=v_cons.qty THEN
      DELETE FROM public.inv_lot_consumptions WHERE id=v_cons.id;
    ELSE
      UPDATE public.inv_lot_consumptions SET qty=qty-v_restore WHERE id=v_cons.id;
    END IF;
    v_restored_cost:=v_restored_cost+(v_restore*COALESCE(v_cons.unit_cost,0));
    v_remaining:=v_remaining-v_restore;
  END LOOP;

  INSERT INTO public.inv_stock_movements(
    product_id,movement_type,qty,ref_type,ref_id,note,unit_cost,total_cost,created_by
  ) VALUES (
    v_product_id,'pick_reversal',v_excess,'wms_orders',v_ref_id,
    'คืนยอดตัดสต๊อก WMS ซ้ำ: '||BTRIM(p_reason),
    CASE WHEN v_excess>0 THEN v_restored_cost/v_excess ELSE 0 END,
    v_restored_cost,auth.uid()
  );

  UPDATE public.inv_stock_balances
  SET on_hand=COALESCE(on_hand,0)+v_excess,updated_at=NOW()
  WHERE product_id=v_product_id;
  PERFORM public.fn_recalc_product_landed_cost(v_product_id);

  INSERT INTO public.wms_stock_repair_audit(order_item_id,product_id,repaired_qty,reason,repaired_by)
  VALUES(p_order_item_id,v_product_id,v_excess,BTRIM(p_reason),auth.uid());

  RETURN jsonb_build_object('success',true,'repaired_qty',v_excess);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_repair_wms_excess_deduction(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_excess_deduction(UUID,TEXT) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.rpc_get_wms_stock_anomalies(p_from_date DATE,p_to_date DATE)
RETURNS TABLE(
  order_item_id UUID, order_id UUID, bill_no TEXT, entry_date DATE, work_order_id UUID,
  work_order_name TEXT, product_code TEXT, product_name TEXT, unit_name TEXT,
  expected_qty NUMERIC, wms_qty NUMERIC, correct_qty NUMERIC, deducted_qty NUMERIC,
  anomaly_type TEXT, repairable BOOLEAN
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH base AS (
    SELECT oi.id order_item_id,o.id order_id,o.bill_no,o.entry_date,o.work_order_id,o.work_order_name,
      p.product_code::TEXT,oi.product_name,COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น') unit_name,
      COALESCE(oi.quantity,1)::NUMERIC expected_qty
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.entry_date BETWEEN p_from_date AND p_to_date
      AND EXISTS (SELECT 1 FROM public.us_users au WHERE au.id=auth.uid()
        AND au.role IN ('superadmin','admin','store','manager'))
      AND o.status='จัดส่งแล้ว' AND NOT COALESCE(oi.is_detail_row,false)
      AND COALESCE(oi.cancellation_stock_action,'')<>'recalled'
      AND o.work_order_id IS NOT NULL
  ), wms_agg AS (
    SELECT w.source_order_item_id,
      SUM(w.qty) FILTER (WHERE w.status<>'cancelled') wms_qty,
      SUM(w.qty) FILTER (WHERE w.status='correct') correct_qty
    FROM public.wms_orders w WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), movement_agg AS (
    SELECT w.source_order_item_id,
      SUM(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')) stock_qty,
      COUNT(*) FILTER (WHERE m.movement_type='pick_reversal') reversal_count
    FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
    WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), agg AS (
    SELECT b.*,COALESCE(w.wms_qty,0) wms_qty,COALESCE(w.correct_qty,0) correct_qty,
      COALESCE(m.stock_qty,0) deducted_qty,COALESCE(m.reversal_count,0) reversal_count,
      public.fn_wms_item_has_unlinked_legacy_conflict(b.order_item_id) legacy_conflict
    FROM base b
    LEFT JOIN wms_agg w ON w.source_order_item_id=b.order_item_id
    LEFT JOIN movement_agg m ON m.source_order_item_id=b.order_item_id
  )
  SELECT a.order_item_id,a.order_id,a.bill_no,a.entry_date,a.work_order_id,a.work_order_name,
    a.product_code,a.product_name,a.unit_name,a.expected_qty,a.wms_qty,a.correct_qty,a.deducted_qty,
    CASE WHEN a.legacy_conflict THEN 'legacy_conflict'
         WHEN a.wms_qty<a.expected_qty THEN 'missing_wms'
         WHEN a.wms_qty>a.expected_qty THEN 'excess_wms'
         WHEN a.correct_qty<>a.expected_qty THEN 'not_correct'
         WHEN a.correct_qty<>a.deducted_qty THEN 'stock_movement_mismatch'
         ELSE 'unknown' END,
    CASE
      WHEN a.wms_qty<a.expected_qty AND NOT public.fn_wms_item_has_legacy_stock_conflict(a.order_item_id) THEN true
      WHEN a.wms_qty=a.expected_qty AND a.correct_qty=a.expected_qty
        AND a.deducted_qty>a.correct_qty AND a.reversal_count=0 AND NOT a.legacy_conflict THEN true
      ELSE false
    END
  FROM agg a
  WHERE a.wms_qty<>a.expected_qty OR a.correct_qty<>a.expected_qty
    OR a.correct_qty<>a.deducted_qty OR a.legacy_conflict
  ORDER BY a.entry_date DESC,a.bill_no,a.product_code;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) TO authenticated,service_role;

COMMIT;
