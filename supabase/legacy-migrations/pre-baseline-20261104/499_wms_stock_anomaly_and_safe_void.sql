-- 499: Mixed-work-order completeness, safe WMS void, and stock anomaly report.

ALTER TABLE public.wms_orders
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS void_previous_status TEXT;

CREATE TABLE IF NOT EXISTS public.wms_order_void_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wms_order_id UUID NOT NULL,
  work_order_id UUID,
  order_display_name TEXT,
  source_order_id UUID,
  source_order_item_id UUID,
  product_code TEXT,
  product_name TEXT,
  qty NUMERIC,
  previous_status TEXT,
  reason TEXT NOT NULL,
  stock_reversed_qty NUMERIC NOT NULL DEFAULT 0,
  voided_by UUID NOT NULL REFERENCES public.us_users(id),
  voided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wms_void_audit_work_order
  ON public.wms_order_void_audit(work_order_id, voided_at DESC);

ALTER TABLE public.wms_order_void_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can view WMS void history" ON public.wms_order_void_audit;
CREATE POLICY "Authenticated users can view WMS void history"
  ON public.wms_order_void_audit FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store','production','manager','picker'))
  );
GRANT SELECT ON public.wms_order_void_audit TO authenticated;

-- No authenticated role may physically delete. Superadmin uses the audited soft-void RPC below.
DROP POLICY IF EXISTS "WMS orders policy" ON public.wms_orders;
DROP POLICY IF EXISTS "WMS users can manage orders" ON public.wms_orders;
DROP POLICY IF EXISTS "Admins and WMS can manage orders" ON public.wms_orders;
DROP POLICY IF EXISTS "WMS orders read" ON public.wms_orders;
DROP POLICY IF EXISTS "WMS orders write" ON public.wms_orders;
DROP POLICY IF EXISTS "Authenticated can view WMS orders" ON public.wms_orders;
DROP POLICY IF EXISTS "WMS roles can insert orders" ON public.wms_orders;
DROP POLICY IF EXISTS "WMS roles can update orders" ON public.wms_orders;
DROP POLICY IF EXISTS "Only superadmin can delete WMS orders" ON public.wms_orders;

CREATE POLICY "Authenticated can view WMS orders" ON public.wms_orders
  FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store','production','manager','picker'))
  );
CREATE POLICY "WMS roles can insert orders" ON public.wms_orders
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
      AND u.role IN ('superadmin','admin','store','production','manager','picker'))
  );
CREATE POLICY "WMS roles can update orders" ON public.wms_orders
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
    AND u.role IN ('superadmin','admin','store','production','manager','picker')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.us_users u WHERE u.id=auth.uid()
    AND u.role IN ('superadmin','admin','store','production','manager','picker')));
CREATE OR REPLACE FUNCTION public.fn_wms_try_auto_consume_non_pick(p_work_order_name TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_nm TEXT := trim(coalesce(p_work_order_name,''));
  v_expected INT;
  v_linked INT;
BEGIN
  IF v_nm='' THEN RETURN; END IF;

  SELECT coalesce(wo.order_count,0) INTO v_expected
  FROM public.or_work_orders wo
  WHERE trim(coalesce(wo.work_order_name,''))=v_nm AND wo.status='กำลังผลิต'
  LIMIT 1;
  IF coalesce(v_expected,0)<=0 THEN RETURN; END IF;

  SELECT count(*) INTO v_linked FROM public.or_orders o
  WHERE trim(coalesce(o.work_order_name,''))=v_nm;
  IF v_linked<v_expected THEN RETURN; END IF;

  -- Insert only missing non-pick source rows. This works for mixed work orders and is idempotent.
  INSERT INTO public.wms_orders(
    work_order_id,order_id,source_order_id,source_order_item_id,
    product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode
  )
  SELECT o.work_order_id,v_nm,o.id,oi.id,
    coalesce(nullif(trim(p.product_code::text),''),oi.product_name,'N/A'),
    oi.product_name,coalesce(p.storage_location::text,''),coalesce(oi.quantity,1)::numeric,
    coalesce(nullif(trim(p.unit_name::text),''),'ชิ้น'),'pending',NULL,'system_complete'
  FROM public.or_orders o
  JOIN public.or_order_items oi ON oi.order_id=o.id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE trim(coalesce(o.work_order_name,''))=v_nm
    AND NOT coalesce(oi.is_detail_row,false)
    AND NOT public.fn_wms_is_pickable_category(p.product_category::text)
    AND NOT EXISTS (
      SELECT 1 FROM public.wms_orders w
      WHERE w.source_order_item_id=oi.id AND w.status<>'cancelled'
    );

  UPDATE public.wms_orders SET status='correct', end_time=coalesce(end_time,now())
  WHERE trim(coalesce(order_id,''))=v_nm
    AND fulfillment_mode='system_complete' AND status='pending';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_void_wms_orders(p_wms_order_ids UUID[], p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_role TEXT; v_row public.wms_orders%ROWTYPE; v_id UUID; v_source_action TEXT;
  v_reversed NUMERIC; v_expected_reverse NUMERIC; v_reverse_product UUID; v_count INT := 0;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id=auth.uid();
  IF v_role IS DISTINCT FROM 'superadmin' THEN RAISE EXCEPTION 'เฉพาะ superadmin เท่านั้นที่ยกเลิกรายการได้'; END IF;
  IF coalesce(array_length(p_wms_order_ids,1),0)=0 THEN RAISE EXCEPTION 'ไม่พบรายการ'; END IF;
  IF length(trim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลอย่างน้อย 3 ตัวอักษร'; END IF;

  FOREACH v_id IN ARRAY p_wms_order_ids LOOP
    SELECT * INTO v_row FROM public.wms_orders WHERE id=v_id FOR UPDATE;
    IF v_row.id IS NULL OR v_row.status='cancelled' THEN CONTINUE; END IF;
    v_reversed := 0;
    IF v_row.status='correct' THEN
      SELECT cancellation_stock_action INTO v_source_action
      FROM public.or_order_items WHERE id=v_row.source_order_item_id;
      SELECT m.product_id,abs(m.qty) INTO v_reverse_product,v_expected_reverse
      FROM public.inv_stock_movements m
      WHERE m.ref_type='wms_orders' AND m.ref_id=v_row.id AND m.movement_type='pick'
      ORDER BY m.created_at DESC LIMIT 1;
      v_reversed := public.fn_reverse_wms_stock(v_row.id);
      -- fn_reverse_wms_stock restores FIFO-consumed lots. If stock was negative and no lot
      -- existed, restore the remaining balance explicitly so a void can never deduct twice.
      IF v_reverse_product IS NOT NULL AND coalesce(v_reversed,0)<coalesce(v_expected_reverse,0) THEN
        INSERT INTO public.inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note)
        VALUES(v_reverse_product,'pick_reversal',v_expected_reverse-coalesce(v_reversed,0),
          'wms_orders',v_row.id,'คืนสต๊อคส่วนที่ไม่มี FIFO lot จากการยกเลิกรายการ WMS');
        UPDATE public.inv_stock_balances SET on_hand=coalesce(on_hand,0)+v_expected_reverse-coalesce(v_reversed,0)
        WHERE product_id=v_reverse_product;
        v_reversed:=v_expected_reverse;
      END IF;
      -- Voiding a WMS row is not cancellation of the sold order item.
      UPDATE public.or_order_items SET cancellation_stock_action=v_source_action
      WHERE id=v_row.source_order_item_id;
    ELSIF v_row.status='picked' THEN
      UPDATE public.inv_stock_balances b
      SET reserved=greatest(coalesce(b.reserved,0)-(v_row.qty*coalesce(p.unit_multiplier,1)),0)
      FROM public.pr_products p
      WHERE p.id=b.product_id AND p.product_code=v_row.product_code;
    END IF;

    INSERT INTO public.wms_order_void_audit(
      wms_order_id,work_order_id,order_display_name,source_order_id,source_order_item_id,
      product_code,product_name,qty,previous_status,reason,stock_reversed_qty,voided_by
    ) VALUES (v_row.id,v_row.work_order_id,v_row.order_id,v_row.source_order_id,v_row.source_order_item_id,
      v_row.product_code,v_row.product_name,v_row.qty,v_row.status,trim(p_reason),coalesce(v_reversed,0),auth.uid());

    UPDATE public.wms_orders SET status='cancelled',voided_at=now(),voided_by=auth.uid(),
      void_reason=trim(p_reason),void_previous_status=v_row.status,end_time=coalesce(end_time,now())
    WHERE id=v_row.id;
    v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('success',true,'voided_count',v_count);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_void_wms_orders(UUID[],TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_void_wms_orders(UUID[],TEXT) TO authenticated,service_role;

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
      p.product_code::text,oi.product_name,coalesce(nullif(trim(p.unit_name::text),''),'ชิ้น') unit_name,
      coalesce(oi.quantity,1)::numeric expected_qty,coalesce(p.unit_multiplier,1)::numeric unit_multiplier
    FROM public.or_orders o
    JOIN public.or_order_items oi ON oi.order_id=o.id
    JOIN public.pr_products p ON p.id=oi.product_id
    WHERE o.entry_date BETWEEN p_from_date AND p_to_date
      AND EXISTS (SELECT 1 FROM public.us_users au WHERE au.id=auth.uid()
        AND au.role IN ('superadmin','admin','store','manager'))
      AND o.status='จัดส่งแล้ว' AND NOT coalesce(oi.is_detail_row,false)
      AND coalesce(oi.cancellation_stock_action,'')<>'recalled'
      AND o.work_order_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.wms_orders wx WHERE wx.work_order_id=o.work_order_id AND wx.status<>'cancelled')
  ), wms_agg AS (
    SELECT w.source_order_item_id,
      sum(w.qty) FILTER (WHERE w.status<>'cancelled') wms_qty,
      sum(w.qty) FILTER (WHERE w.status='correct') correct_qty
    FROM public.wms_orders w WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), movement_agg AS (
    SELECT w.source_order_item_id,
      sum(-m.qty) FILTER (WHERE m.movement_type IN ('pick','pick_reversal')) stock_qty
    FROM public.wms_orders w
    JOIN public.inv_stock_movements m ON m.ref_type='wms_orders' AND m.ref_id=w.id
    WHERE w.source_order_item_id IS NOT NULL
    GROUP BY w.source_order_item_id
  ), agg AS (
    SELECT b.*,coalesce(w.wms_qty,0) wms_qty,coalesce(w.correct_qty,0) correct_qty,
      coalesce(m.stock_qty,0)/nullif(b.unit_multiplier,0) deducted_qty
    FROM base b
    LEFT JOIN wms_agg w ON w.source_order_item_id=b.order_item_id
    LEFT JOIN movement_agg m ON m.source_order_item_id=b.order_item_id
  )
  SELECT a.order_item_id,a.order_id,a.bill_no,a.entry_date,a.work_order_id,a.work_order_name,
    a.product_code,a.product_name,a.unit_name,a.expected_qty,a.wms_qty,a.correct_qty,a.deducted_qty,
    CASE WHEN a.wms_qty<a.expected_qty THEN 'missing_wms'
         WHEN a.wms_qty>a.expected_qty THEN 'excess_wms'
         WHEN a.correct_qty<>a.expected_qty THEN 'not_correct'
         WHEN a.correct_qty<>a.deducted_qty THEN 'stock_movement_mismatch'
         ELSE 'unknown' END,
    (a.wms_qty<a.expected_qty)
  FROM agg a
  WHERE a.wms_qty<>a.expected_qty OR a.correct_qty<>a.expected_qty OR a.correct_qty<>a.deducted_qty
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

  SELECT oi.id,oi.order_id,oi.product_name,coalesce(oi.quantity,1)::numeric qty,o.work_order_id,o.work_order_name,
    p.product_code::text product_code,coalesce(p.storage_location::text,'') location,
    coalesce(nullif(trim(p.unit_name::text),''),'ชิ้น') unit_name,
    public.fn_wms_is_pickable_category(p.product_category::text) pickable
  INTO v_item
  FROM public.or_order_items oi JOIN public.or_orders o ON o.id=oi.order_id
  JOIN public.pr_products p ON p.id=oi.product_id
  WHERE oi.id=p_order_item_id AND NOT coalesce(oi.is_detail_row,false)
  FOR UPDATE OF oi;
  IF v_item.id IS NULL OR v_item.work_order_id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการหรือรายการยังไม่มีใบงาน'; END IF;

  SELECT coalesce(sum(qty),0) INTO v_existing FROM public.wms_orders
  WHERE source_order_item_id=p_order_item_id AND status<>'cancelled';
  v_missing:=v_item.qty-v_existing;
  IF v_missing<=0 THEN RETURN jsonb_build_object('success',true,'created_qty',0,'message','รายการตรงกันแล้ว'); END IF;

  IF v_item.pickable THEN
    SELECT assigned_to INTO v_picker FROM public.wms_orders
    WHERE work_order_id=v_item.work_order_id AND fulfillment_mode='warehouse_pick' AND status<>'cancelled'
      AND assigned_to IS NOT NULL LIMIT 1;
    IF v_picker IS NULL THEN RAISE EXCEPTION 'ไม่พบผู้หยิบของใบงาน กรุณามอบหมาย Picker ก่อน'; END IF;
    v_mode:='warehouse_pick';
  ELSE v_mode:='system_complete'; END IF;

  INSERT INTO public.wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,product_code,
    product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
  VALUES(v_item.work_order_id,v_item.work_order_name,v_item.order_id,v_item.id,v_item.product_code,
    v_item.product_name,v_item.location,v_missing,v_item.unit_name,'pending',v_picker,v_mode);

  IF v_mode='system_complete' THEN
    UPDATE public.wms_orders SET status='correct',end_time=now()
    WHERE source_order_item_id=v_item.id AND status='pending' AND fulfillment_mode='system_complete';
  END IF;
  RETURN jsonb_build_object('success',true,'created_qty',v_missing,'mode',v_mode);
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_repair_wms_missing_item(UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_repair_wms_missing_item(UUID) TO authenticated,service_role;

INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access)
SELECT r.role,'wms-stock-anomaly','สต๊อคผิดปกติ',true
FROM (VALUES ('superadmin'),('admin'),('store'),('manager')) AS r(role)
ON CONFLICT(role,menu_key) DO UPDATE SET menu_name=excluded.menu_name;
