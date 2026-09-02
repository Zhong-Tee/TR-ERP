-- 500: Configurable non-picker categories and guarded bulk anomaly repair.

CREATE TABLE IF NOT EXISTS public.wms_non_picker_categories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category_name TEXT NOT NULL,
  created_by UUID REFERENCES public.us_users(id) DEFAULT auth.uid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wms_non_picker_category_not_blank CHECK (BTRIM(category_name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wms_non_picker_category_normalized
  ON public.wms_non_picker_categories (UPPER(BTRIM(category_name)));

-- Preserve every category that was considered non-pick before this migration.
INSERT INTO public.wms_non_picker_categories(category_name)
SELECT DISTINCT BTRIM(p.product_category::TEXT)
FROM public.pr_products p
WHERE NULLIF(BTRIM(COALESCE(p.product_category::TEXT,'')),'') IS NOT NULL
  AND NOT (
    UPPER(BTRIM(p.product_category::TEXT)) LIKE '%STAMP%'
    OR UPPER(BTRIM(p.product_category::TEXT)) LIKE '%LASER%'
    OR UPPER(BTRIM(p.product_category::TEXT)) LIKE '%SUBLIMATION%'
    OR UPPER(BTRIM(p.product_category::TEXT)) IN ('CALENDAR','ETC','INK')
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.pr_products p2
    WHERE UPPER(BTRIM(COALESCE(p2.product_category::TEXT,''))) =
          UPPER(BTRIM(COALESCE(p.product_category::TEXT,'')))
      AND NULLIF(BTRIM(COALESCE(p2.rubber_code::TEXT,'')),'') IS NOT NULL
  )
ON CONFLICT DO NOTHING;

ALTER TABLE public.wms_non_picker_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "WMS roles can view non-picker categories"
  ON public.wms_non_picker_categories FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store','production','manager','picker'))
  );
CREATE POLICY "WMS admins can insert non-picker categories"
  ON public.wms_non_picker_categories FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store'))
  );
CREATE POLICY "WMS admins can delete non-picker categories"
  ON public.wms_non_picker_categories FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store'))
  );
GRANT SELECT,INSERT,DELETE ON public.wms_non_picker_categories TO authenticated;

-- The setting is authoritative: configured categories auto-complete; every new,
-- non-empty unconfigured category goes through Picker by default (safer default).
CREATE OR REPLACE FUNCTION public.fn_wms_is_pickable_category(p_cat TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN NULLIF(BTRIM(COALESCE(p_cat,'')),'') IS NULL THEN false
    WHEN EXISTS (
      SELECT 1 FROM public.wms_non_picker_categories c
      WHERE UPPER(BTRIM(c.category_name))=UPPER(BTRIM(p_cat))
    ) THEN false
    ELSE true
  END;
$$;

COMMENT ON FUNCTION public.fn_wms_is_pickable_category(TEXT) IS
  'false=system_complete จากเมนูหมวดสินค้าไม่ต้อง Picker; หมวดใหม่ที่ยังไม่ตั้งค่า default เป็นต้อง Picker';

CREATE OR REPLACE FUNCTION public.fn_wms_item_has_legacy_stock_conflict(p_order_item_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_item RECORD;
  v_linked_correct NUMERIC := 0;
  v_linked_movement NUMERIC := 0;
BEGIN
  SELECT oi.id,oi.order_id source_order_id,o.work_order_id,o.work_order_name,p.product_code::TEXT product_code
  INTO v_item
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id=oi.order_id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE oi.id=p_order_item_id;
  IF v_item.id IS NULL THEN RETURN true; END IF;

  -- A legacy WMS row cannot be allocated safely to a particular bill line.
  IF EXISTS (
    SELECT 1
    FROM public.wms_orders w
    WHERE w.source_order_item_id IS NULL
      AND UPPER(BTRIM(COALESCE(w.product_code,'')))=UPPER(BTRIM(COALESCE(v_item.product_code,'')))
      AND (w.work_order_id=v_item.work_order_id OR w.source_order_id=v_item.source_order_id OR
        (w.work_order_id IS NULL AND BTRIM(COALESCE(w.order_id,''))=BTRIM(COALESCE(v_item.work_order_name,''))))
      AND (
        w.status<>'cancelled'
        OR EXISTS (
          SELECT 1 FROM public.inv_stock_movements m
          WHERE m.ref_type='wms_orders' AND m.ref_id=w.id
          GROUP BY m.ref_id HAVING COALESCE(SUM(-m.qty) FILTER
            (WHERE m.movement_type IN ('pick','pick_reversal')),0)<>0
        )
      )
  ) THEN RETURN true; END IF;

  SELECT COALESCE(SUM(w.qty) FILTER (WHERE w.status='correct'),0)
  INTO v_linked_correct
  FROM public.wms_orders w WHERE w.source_order_item_id=p_order_item_id;

  SELECT COALESCE(SUM(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')),0)
  INTO v_linked_movement
  FROM public.wms_orders w
  JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
  WHERE w.source_order_item_id=p_order_item_id;

  RETURN v_linked_correct<>v_linked_movement;
END;
$$;
REVOKE ALL ON FUNCTION public.fn_wms_item_has_legacy_stock_conflict(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_wms_item_has_legacy_stock_conflict(UUID) TO authenticated,service_role;

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
      AND EXISTS (SELECT 1 FROM public.wms_orders wx
        WHERE wx.work_order_id=o.work_order_id AND wx.status<>'cancelled')
  ), wms_agg AS (
    SELECT w.source_order_item_id,
      SUM(w.qty) FILTER (WHERE w.status<>'cancelled') wms_qty,
      SUM(w.qty) FILTER (WHERE w.status='correct') correct_qty
    FROM public.wms_orders w WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), movement_agg AS (
    SELECT w.source_order_item_id,
      SUM(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')) stock_qty
    FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
    WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), agg AS (
    SELECT b.*,COALESCE(w.wms_qty,0) wms_qty,COALESCE(w.correct_qty,0) correct_qty,
      COALESCE(m.stock_qty,0) deducted_qty,
      public.fn_wms_item_has_legacy_stock_conflict(b.order_item_id) legacy_conflict
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
    (a.wms_qty<a.expected_qty AND NOT a.legacy_conflict)
  FROM agg a
  WHERE a.wms_qty<>a.expected_qty OR a.correct_qty<>a.expected_qty
    OR a.correct_qty<>a.deducted_qty OR a.legacy_conflict
  ORDER BY a.entry_date DESC,a.bill_no,a.product_code;
$$;
REVOKE ALL ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_wms_stock_anomalies(DATE,DATE) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.rpc_repair_wms_missing_item(p_order_item_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_item RECORD; v_existing NUMERIC; v_missing NUMERIC; v_picker UUID; v_mode TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store') THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ซ่อมสต๊อค'; END IF;

  SELECT oi.id,oi.order_id,oi.product_name,COALESCE(oi.quantity,1)::NUMERIC qty,o.work_order_id,o.work_order_name,
    p.product_code::TEXT product_code,COALESCE(p.storage_location::TEXT,'') location,
    COALESCE(NULLIF(BTRIM(p.unit_name::TEXT),''),'ชิ้น') unit_name,
    public.fn_wms_is_pickable_category(p.product_category::TEXT) pickable
  INTO v_item
  FROM public.or_order_items oi JOIN public.or_orders o ON o.id=oi.order_id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE oi.id=p_order_item_id AND NOT COALESCE(oi.is_detail_row,false)
  FOR UPDATE OF oi;
  IF v_item.id IS NULL OR v_item.work_order_id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการหรือรายการยังไม่มีใบงาน'; END IF;

  SELECT COALESCE(SUM(qty),0) INTO v_existing FROM public.wms_orders
  WHERE source_order_item_id=p_order_item_id AND status<>'cancelled';
  v_missing:=v_item.qty-v_existing;
  IF v_missing<=0 THEN RETURN jsonb_build_object('success',true,'created_qty',0,'message','รายการตรงกันแล้ว'); END IF;
  IF public.fn_wms_item_has_legacy_stock_conflict(p_order_item_id) THEN
    RAISE EXCEPTION 'พบ WMS/Movement รุ่นเก่าหรือยอด Movement ไม่สัมพันธ์ ระบบบล็อกเพื่อป้องกันตัดซ้ำ';
  END IF;

  IF v_item.pickable THEN
    SELECT assigned_to INTO v_picker FROM public.wms_orders
    WHERE work_order_id=v_item.work_order_id
      AND (fulfillment_mode='warehouse_pick' OR fulfillment_mode IS NULL)
      AND status<>'cancelled'
      AND assigned_to IS NOT NULL LIMIT 1;
    IF v_picker IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้หยิบของใบงาน กรุณามอบหมาย Picker ก่อน'; END IF;
    v_mode:='warehouse_pick';
  ELSE v_mode:='system_complete'; END IF;

  INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,product_code,
    product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
  VALUES(v_item.work_order_id,v_item.work_order_name,v_item.order_id,v_item.id,v_item.product_code,
    v_item.product_name,v_item.location,v_missing,v_item.unit_name,'pending',v_picker,v_mode);

  IF v_mode='system_complete' THEN
    UPDATE public.wms_orders SET status='correct',end_time=NOW()
    WHERE source_order_item_id=v_item.id AND status='pending' AND fulfillment_mode='system_complete';
  END IF;
  RETURN jsonb_build_object('success',true,'created_qty',v_missing,'mode',v_mode);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_repair_wms_missing_item(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_missing_item(UUID) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.rpc_repair_all_wms_missing_items(p_from_date DATE,p_to_date DATE)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; r RECORD; v_result JSONB;
  v_repaired_rows INT:=0; v_repaired_qty NUMERIC:=0; v_picker_rows INT:=0;
  v_system_rows INT:=0; v_skipped_rows INT:=0; v_errors JSONB:='[]'::JSONB;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store') THEN RAISE EXCEPTION 'ไม่มีสิทธิ์ซ่อมสต๊อค'; END IF;
  IF p_from_date IS NULL OR p_to_date IS NULL OR p_from_date>p_to_date THEN RAISE EXCEPTION 'ช่วงวันที่ไม่ถูกต้อง'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('wms-bulk-repair-'||p_from_date::TEXT||'-'||p_to_date::TEXT));

  FOR r IN
    SELECT * FROM public.rpc_get_wms_stock_anomalies(p_from_date,p_to_date)
    WHERE anomaly_type='missing_wms' AND repairable
    ORDER BY work_order_name,bill_no,product_code,order_item_id
  LOOP
    BEGIN
      v_result:=public.rpc_repair_wms_missing_item(r.order_item_id);
      IF COALESCE((v_result->>'created_qty')::NUMERIC,0)>0 THEN
        v_repaired_rows:=v_repaired_rows+1;
        v_repaired_qty:=v_repaired_qty+(v_result->>'created_qty')::NUMERIC;
        IF v_result->>'mode'='system_complete' THEN v_system_rows:=v_system_rows+1;
        ELSE v_picker_rows:=v_picker_rows+1; END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_skipped_rows:=v_skipped_rows+1;
      IF jsonb_array_length(v_errors)<20 THEN
        v_errors:=v_errors||jsonb_build_array(jsonb_build_object(
          'bill_no',r.bill_no,'product_code',r.product_code,'error',SQLERRM));
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('success',true,'repaired_rows',v_repaired_rows,
    'repaired_qty',v_repaired_qty,'system_complete_rows',v_system_rows,
    'picker_rows',v_picker_rows,'skipped_rows',v_skipped_rows,'errors',v_errors);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_repair_all_wms_missing_items(DATE,DATE) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_all_wms_missing_items(DATE,DATE) TO authenticated,service_role;
