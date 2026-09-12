-- Separate saleable order-item rows from per-layer detail rows.

ALTER TABLE or_order_items
  ADD COLUMN IF NOT EXISTS parent_item_id UUID REFERENCES or_order_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS is_detail_row BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_or_order_items_parent_item_id
  ON or_order_items(parent_item_id) WHERE parent_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_or_order_items_main_rows
  ON or_order_items(order_id, product_id) WHERE is_detail_row = false;

-- Backfill legacy condo rows. Item UID suffix follows the form bill-1, bill-2, ...
UPDATE or_order_items oi
SET is_detail_row = true
FROM pr_products p
WHERE p.id = oi.product_id
  AND upper(trim(coalesce(p.product_category, ''))) IN ('CONDO STAMP 2FL', 'CONDO STAMP 3FL', 'CONDO STAMP 5FL')
  AND coalesce(oi.product_type, 'ชั้น1') <> 'ชั้น1';

UPDATE or_order_items child
SET parent_item_id = (
  SELECT pitem.id
  FROM or_order_items pitem
  WHERE pitem.order_id = child.order_id
    AND pitem.product_id = child.product_id
    AND coalesce(pitem.product_type, 'ชั้น1') = 'ชั้น1'
    AND coalesce(
      nullif(regexp_replace(pitem.item_uid, '^.*-([0-9]+)$', '\1'), pitem.item_uid)::int,
      0
    ) < coalesce(
      nullif(regexp_replace(child.item_uid, '^.*-([0-9]+)$', '\1'), child.item_uid)::int,
      2147483647
    )
  ORDER BY coalesce(nullif(regexp_replace(pitem.item_uid, '^.*-([0-9]+)$', '\1'), pitem.item_uid)::int, 0) DESC
  LIMIT 1
)
WHERE child.is_detail_row = true
  AND child.parent_item_id IS NULL;

-- Latest WMS assignment RPC: detail rows never create stock lines and no divisor is needed.
CREATE OR REPLACE FUNCTION rpc_assign_wms_for_work_order_v2(
  p_work_order_id UUID,
  p_picker_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT; v_existing INT; v_has_items BOOLEAN; v_pick_norm INT;
  v_pick_spare INT; v_system INT; v_picker_ok BOOLEAN; v_work_order_name TEXT;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin','admin','store','manager','production') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์มอบหมาย WMS';
  END IF;
  IF p_work_order_id IS NULL THEN RETURN jsonb_build_object('success',false,'error','ต้องระบุใบงาน'); END IF;
  SELECT work_order_name INTO v_work_order_name FROM or_work_orders WHERE id = p_work_order_id;
  IF v_work_order_name IS NULL OR trim(v_work_order_name) = '' THEN
    RETURN jsonb_build_object('success',false,'error','ไม่พบใบงาน');
  END IF;
  SELECT EXISTS(SELECT 1 FROM us_users WHERE id=p_picker_id AND role='picker') INTO v_picker_ok;
  IF NOT coalesce(v_picker_ok,false) THEN RETURN jsonb_build_object('success',false,'error','ต้องระบุผู้ใช้ role picker ที่ถูกต้อง'); END IF;
  SELECT count(*) INTO v_existing FROM wms_orders WHERE work_order_id=p_work_order_id AND status<>'cancelled';
  IF v_existing>0 THEN RETURN jsonb_build_object('success',false,'error','ใบงานนี้ถูกสร้างในระบบ WMS แล้ว'); END IF;
  SELECT EXISTS(
    SELECT 1 FROM or_orders o JOIN or_order_items oi ON oi.order_id=o.id
    WHERE o.work_order_id=p_work_order_id AND NOT coalesce(oi.is_detail_row,false)
  ) INTO v_has_items;
  IF NOT v_has_items THEN RETURN jsonb_build_object('success',false,'error','ไม่พบรายการสินค้าหลักในใบงานนี้'); END IF;

  WITH base AS (
    SELECT o.id source_order_id, oi.id source_order_item_id, oi.product_id,
      oi.product_name, coalesce(oi.quantity,1)::numeric sum_q, p.product_category::text cat,
      p.product_code::text product_code, p.storage_location::text loc,
      coalesce(nullif(trim(p.unit_name::text),''),'ชิ้น') unit_name
    FROM or_orders o JOIN or_order_items oi ON oi.order_id=o.id JOIN pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id AND NOT coalesce(oi.is_detail_row,false)
      AND fn_wms_is_pickable_category(p.product_category::text)
  ), ins AS (
    INSERT INTO wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,source_order_id,source_order_item_id,
      coalesce(nullif(trim(product_code),''),product_name,'N/A'),product_name,coalesce(loc,''),sum_q,unit_name,'pending',p_picker_id,'warehouse_pick'
    FROM base RETURNING id
  ) SELECT count(*) INTO v_pick_norm FROM ins;

  WITH spare AS (
    SELECT p.rubber_code rc, sum(coalesce(oi.quantity,1)::numeric) sum_q
    FROM or_orders o JOIN or_order_items oi ON oi.order_id=o.id JOIN pr_products p ON p.id=oi.product_id
    WHERE o.work_order_id=p_work_order_id AND NOT coalesce(oi.is_detail_row,false)
      AND p.rubber_code IS NOT NULL AND trim(p.rubber_code::text)<>''
      AND fn_wms_is_pickable_category(p.product_category::text)
    GROUP BY p.rubber_code
  ), ins2 AS (
    INSERT INTO wms_orders(work_order_id,order_id,source_order_id,source_order_item_id,product_code,product_name,location,qty,unit_name,status,assigned_to,fulfillment_mode)
    SELECT p_work_order_id,v_work_order_name,NULL,NULL,'SPARE_PART',rc::text,'อะไหล่',sum_q,'ชิ้น','pending',p_picker_id,'warehouse_pick'
    FROM spare RETURNING id
  ) SELECT count(*) INTO v_pick_spare FROM ins2;

  PERFORM fn_wms_try_auto_consume_non_pick(v_work_order_name);
  SELECT count(*) INTO v_system FROM wms_orders WHERE work_order_id=p_work_order_id AND fulfillment_mode='system_complete' AND status IN ('correct','system_complete');
  RETURN jsonb_build_object('success',true,'work_order_id',p_work_order_id,'work_order_name',v_work_order_name,
    'warehouse_pick_main',coalesce(v_pick_norm,0),'warehouse_pick_spare',coalesce(v_pick_spare,0),'system_complete',coalesce(v_system,0));
END;
$$;

REVOKE ALL ON FUNCTION rpc_assign_wms_for_work_order_v2(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rpc_assign_wms_for_work_order_v2(UUID,UUID) TO authenticated;
