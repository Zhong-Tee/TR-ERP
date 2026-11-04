-- Canonical inventory quantity is the product transaction unit (unit_name).
-- unit_multiplier is descriptive conversion metadata only (for example 1 คู่ = 2 ชิ้น).

-- Historical damage requisitions can predate the photo requirement. Updating an
-- unrelated field (such as unit_name) must not revalidate those legacy rows.
CREATE OR REPLACE FUNCTION public.validate_wms_production_damage_photos()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.requisition_topic IS NOT DISTINCT FROM OLD.requisition_topic
     AND NEW.item_note IS NOT DISTINCT FROM OLD.item_note
     AND NEW.damage_image_paths IS NOT DISTINCT FROM OLD.damage_image_paths
  THEN
    RETURN NEW;
  END IF;

  IF NEW.requisition_topic IN ('ผลิตเสีย', 'สินค้าชำรุด')
     AND (
       NULLIF(BTRIM(NEW.item_note), '') IS NULL
       OR COALESCE(CARDINALITY(NEW.damage_image_paths), 0) < 1
     )
  THEN
    RAISE EXCEPTION 'Damage requisition requires a note and at least one photo';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE public.wms_requisition_items
  ADD COLUMN IF NOT EXISTS unit_name TEXT;

UPDATE public.wms_requisition_items ri
SET unit_name = COALESCE(NULLIF(TRIM(p.unit_name), ''), 'ชิ้น')
FROM public.pr_products p
WHERE p.product_code = ri.product_code
  AND (ri.unit_name IS NULL OR TRIM(ri.unit_name) = '');

ALTER TABLE public.wms_requisition_items
  ALTER COLUMN unit_name SET DEFAULT 'ชิ้น';

ALTER TABLE public.inv_audit_items
  ADD COLUMN IF NOT EXISTS unit_name TEXT;

UPDATE public.inv_audit_items ai
SET unit_name = COALESCE(NULLIF(TRIM(p.unit_name), ''), 'ชิ้น')
FROM public.pr_products p
WHERE p.id = ai.product_id
  AND (ai.unit_name IS NULL OR TRIM(ai.unit_name) = '');

ALTER TABLE public.inv_audit_items
  ALTER COLUMN unit_name SET DEFAULT 'ชิ้น';

-- Older requisition approval inserted the WMS default "ชิ้น" instead of the product unit.
UPDATE public.wms_orders w
SET unit_name = COALESCE(NULLIF(TRIM(p.unit_name), ''), 'ชิ้น')
FROM public.pr_products p
WHERE p.product_code = w.product_code
  AND w.order_id LIKE 'REQ-%'
  AND w.unit_name IS DISTINCT FROM COALESCE(NULLIF(TRIM(p.unit_name), ''), 'ชิ้น');

CREATE OR REPLACE FUNCTION public.inv_deduct_stock_on_wms_picked()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_id UUID;
  v_movement_id UUID;
  v_stock_qty NUMERIC;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT id INTO v_product_id
  FROM public.pr_products
  WHERE product_code = NEW.product_code
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
    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_product_id, -v_stock_qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = COALESCE(public.inv_stock_balances.on_hand, 0) - v_stock_qty,
          reserved = GREATEST(COALESCE(public.inv_stock_balances.reserved, 0) - v_stock_qty, 0),
          updated_at = NOW();

    INSERT INTO public.inv_stock_movements (product_id, movement_type, qty, ref_type, ref_id, note)
    VALUES (v_product_id, 'pick', -v_stock_qty, 'wms_orders', NEW.id,
            'ตัดสต๊อกตามหน่วยสินค้า ' || COALESCE(NULLIF(TRIM(NEW.unit_name), ''), 'ชิ้น'))
    RETURNING id INTO v_movement_id;

    PERFORM public.fn_consume_stock_fifo(v_product_id, v_stock_qty, v_movement_id);
    PERFORM public.fn_recalc_product_landed_cost(v_product_id);
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

CREATE OR REPLACE FUNCTION public.fn_guard_or_order_items_stock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_on_hand NUMERIC := 0;
  v_reserved NUMERIC := 0;
  v_available NUMERIC := 0;
  v_new_qty NUMERIC := 0;
  v_other_qty NUMERIC := 0;
  v_product_code TEXT := '';
  v_unit_name TEXT := 'ชิ้น';
BEGIN
  IF NEW.product_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.product_id = OLD.product_id
     AND COALESCE(NEW.quantity, 0) = COALESCE(OLD.quantity, 0)
  THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(product_code, ''), COALESCE(NULLIF(TRIM(unit_name), ''), 'ชิ้น')
  INTO v_product_code, v_unit_name
  FROM public.pr_products
  WHERE id = NEW.product_id;

  v_new_qty := COALESCE(NEW.quantity, 0);
  IF v_new_qty <= 0 THEN RETURN NEW; END IF;

  SELECT COALESCE(on_hand, 0), COALESCE(reserved, 0)
  INTO v_on_hand, v_reserved
  FROM public.inv_stock_balances
  WHERE product_id = NEW.product_id;

  v_available := v_on_hand - v_reserved;

  SELECT COALESCE(SUM(oi.quantity), 0)
  INTO v_other_qty
  FROM public.or_order_items oi
  WHERE oi.order_id = NEW.order_id
    AND oi.product_id = NEW.product_id
    AND (TG_OP <> 'UPDATE' OR oi.id <> OLD.id);

  IF v_available <= 0 OR (v_other_qty + v_new_qty) > v_available THEN
    RAISE EXCEPTION
      'ไม่สามารถเปิดบิลได้: สินค้า % คงเหลือขายได้ % % แต่ต้องการ % %',
      COALESCE(NULLIF(v_product_code, ''), NEW.product_id::TEXT),
      v_available, v_unit_name, (v_other_qty + v_new_qty), v_unit_name;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_reverse_wms_stock(p_wms_order_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_movement RECORD;
  v_consumption RECORD;
  v_product_id UUID;
  v_total_returned NUMERIC := 0;
  v_wms RECORD;
  v_reserved_qty NUMERIC := 0;
BEGIN
  SELECT id, status, product_code, qty, stock_action, source_order_item_id, order_id
  INTO v_wms FROM public.wms_orders WHERE id = p_wms_order_id;
  IF v_wms.id IS NULL OR v_wms.stock_action IS NOT NULL THEN RETURN 0; END IF;

  SELECT sm.id, sm.product_id, sm.qty, sm.unit_cost
  INTO v_movement
  FROM public.inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders' AND sm.ref_id = p_wms_order_id AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC LIMIT 1;

  IF v_movement.id IS NULL THEN
    SELECT id INTO v_product_id FROM public.pr_products WHERE product_code = v_wms.product_code LIMIT 1;
    IF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
      v_reserved_qty := COALESCE(v_wms.qty, 0);
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_reserved_qty, 0), updated_at = NOW()
      WHERE product_id = v_product_id;
    END IF;
    UPDATE public.wms_orders SET stock_action = 'recalled' WHERE id = p_wms_order_id;
    IF v_wms.source_order_item_id IS NOT NULL THEN
      UPDATE public.or_order_items SET cancellation_stock_action = 'recalled' WHERE id = v_wms.source_order_item_id;
    END IF;
    RETURN v_reserved_qty;
  END IF;

  v_product_id := v_movement.product_id;
  FOR v_consumption IN
    SELECT lc.lot_id, lc.qty FROM public.inv_lot_consumptions lc WHERE lc.movement_id = v_movement.id
  LOOP
    UPDATE public.inv_stock_lots SET qty_remaining = qty_remaining + v_consumption.qty WHERE id = v_consumption.lot_id;
    v_total_returned := v_total_returned + v_consumption.qty;
  END LOOP;

  INSERT INTO public.inv_stock_movements
    (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
  VALUES
    (v_product_id, 'pick_reversal', v_total_returned, 'wms_orders', p_wms_order_id,
     'Stock recall after cancelled bill', COALESCE(v_movement.unit_cost, 0),
     v_total_returned * COALESCE(v_movement.unit_cost, 0));

  UPDATE public.inv_stock_balances
  SET on_hand = COALESCE(on_hand, 0) + v_total_returned, updated_at = NOW()
  WHERE product_id = v_product_id;
  PERFORM public.fn_recalc_product_landed_cost(v_product_id);
  UPDATE public.wms_orders SET stock_action = 'recalled' WHERE id = p_wms_order_id;

  IF v_wms.source_order_item_id IS NOT NULL THEN
    UPDATE public.or_order_items SET cancellation_stock_action = 'recalled' WHERE id = v_wms.source_order_item_id;
  ELSE
    UPDATE public.or_order_items oi
    SET cancellation_stock_action = 'recalled'
    FROM public.or_orders o, public.pr_products p
    WHERE oi.order_id = o.id AND p.id = oi.product_id
      AND oi.cancellation_stock_action = 'pending'
      AND TRIM(COALESCE(o.work_order_name, '')) = TRIM(COALESCE(v_wms.order_id, ''))
      AND UPPER(TRIM(COALESCE(p.product_code::TEXT, ''))) = UPPER(TRIM(COALESCE(v_wms.product_code, '')));
  END IF;
  RETURN v_total_returned;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_cancellation_waste(p_wms_order_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_movement RECORD;
  v_product_id UUID;
  v_qty NUMERIC;
  v_avg_cost NUMERIC;
  v_wms RECORD;
  v_reserved_qty NUMERIC := 0;
BEGIN
  SELECT id, status, product_code, qty, stock_action, source_order_item_id, order_id
  INTO v_wms FROM public.wms_orders WHERE id = p_wms_order_id;
  IF v_wms.id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'wms row not found'); END IF;
  IF v_wms.stock_action IS NOT NULL THEN RETURN jsonb_build_object('success', false, 'error', 'already processed'); END IF;

  SELECT sm.id, sm.product_id, ABS(sm.qty) AS qty, sm.unit_cost
  INTO v_movement
  FROM public.inv_stock_movements sm
  WHERE sm.ref_type = 'wms_orders' AND sm.ref_id = p_wms_order_id AND sm.movement_type = 'pick'
  ORDER BY sm.created_at DESC LIMIT 1;

  IF v_movement.id IS NULL THEN
    SELECT id INTO v_product_id FROM public.pr_products WHERE product_code = v_wms.product_code LIMIT 1;
    IF v_wms.status = 'picked' AND v_product_id IS NOT NULL THEN
      v_reserved_qty := COALESCE(v_wms.qty, 0);
      UPDATE public.inv_stock_balances
      SET reserved = GREATEST(COALESCE(reserved, 0) - v_reserved_qty, 0), updated_at = NOW()
      WHERE product_id = v_product_id;
    END IF;
    UPDATE public.wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;
    IF v_wms.source_order_item_id IS NOT NULL THEN
      UPDATE public.or_order_items SET cancellation_stock_action = 'waste' WHERE id = v_wms.source_order_item_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'note', 'released reserved and marked as waste', 'released_reserved_qty', v_reserved_qty);
  END IF;

  v_product_id := v_movement.product_id;
  v_qty := v_movement.qty;
  v_avg_cost := COALESCE(v_movement.unit_cost, 0);
  INSERT INTO public.inv_stock_movements
    (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost, created_by)
  VALUES
    (v_product_id, 'waste', 0, 'wms_orders', p_wms_order_id, 'Waste mark from cancelled bill', v_avg_cost, 0, p_user_id);
  UPDATE public.wms_orders SET stock_action = 'waste' WHERE id = p_wms_order_id;

  IF v_wms.source_order_item_id IS NOT NULL THEN
    UPDATE public.or_order_items SET cancellation_stock_action = 'waste' WHERE id = v_wms.source_order_item_id;
  ELSE
    UPDATE public.or_order_items oi
    SET cancellation_stock_action = 'waste'
    FROM public.or_orders o, public.pr_products p
    WHERE oi.order_id = o.id AND p.id = oi.product_id
      AND oi.cancellation_stock_action = 'pending'
      AND TRIM(COALESCE(o.work_order_name, '')) = TRIM(COALESCE(v_wms.order_id, ''))
      AND UPPER(TRIM(COALESCE(p.product_code::TEXT, ''))) = UPPER(TRIM(COALESCE(v_wms.product_code, '')));
  END IF;
  RETURN jsonb_build_object('success', true, 'product_id', v_product_id, 'qty', v_qty, 'action', 'waste');
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_wms_requisition(p_requisition_id UUID, p_picker_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_role TEXT;
  v_picker_role TEXT;
  v_requisition public.wms_requisitions%ROWTYPE;
  v_item_count INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = v_uid;
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'store') THEN RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติใบเบิก'; END IF;
  SELECT role INTO v_picker_role FROM public.us_users WHERE id = p_picker_id;
  IF v_picker_role IS DISTINCT FROM 'picker' THEN RAISE EXCEPTION 'ผู้รับงานที่เลือกไม่ใช่ Picker'; END IF;

  SELECT * INTO v_requisition FROM public.wms_requisitions WHERE id = p_requisition_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบใบเบิก'; END IF;
  IF v_requisition.status <> 'pending' THEN RAISE EXCEPTION 'ใบเบิกนี้ไม่ได้อยู่ในสถานะรออนุมัติ (สถานะ: %)', v_requisition.status; END IF;
  SELECT COUNT(*) INTO v_item_count FROM public.wms_requisition_items WHERE requisition_id = v_requisition.requisition_id;
  IF v_item_count = 0 THEN RAISE EXCEPTION 'ใบเบิกนี้ไม่มีรายการสินค้า'; END IF;

  UPDATE public.wms_requisitions SET status = 'approved', approved_by = v_uid, approved_at = NOW() WHERE id = p_requisition_id;
  INSERT INTO public.wms_orders
    (order_id, product_code, product_name, location, qty, unit_name, assigned_to, status)
  SELECT v_requisition.requisition_id, item.product_code, item.product_name, item.location, item.qty,
         COALESCE(NULLIF(TRIM(item.unit_name), ''), NULLIF(TRIM(p.unit_name), ''), 'ชิ้น'), p_picker_id, 'pending'
  FROM public.wms_requisition_items item
  LEFT JOIN public.pr_products p ON p.product_code = item.product_code
  WHERE item.requisition_id = v_requisition.requisition_id
  ORDER BY item.created_at, item.id;
END;
$$;

-- Correct the historical over-deduction for REQ-20260831-001 exactly once.
-- The original movement was -4 because qty 2 คู่ was multiplied by unit_multiplier 2.
DO $$
DECLARE
  v_product_id UUID;
  v_wms_id UUID;
  v_pick_id UUID;
  v_pick_unit_cost NUMERIC := 0;
  v_remaining NUMERIC := 2;
  v_restore NUMERIC;
  v_restored_cost NUMERIC := 0;
  v_cons RECORD;
BEGIN
  SELECT id INTO v_product_id FROM public.pr_products WHERE product_code = '110000413' LIMIT 1;
  IF v_product_id IS NULL OR EXISTS (
    SELECT 1 FROM public.inv_stock_movements
    WHERE product_id = v_product_id AND movement_type = 'adjust'
      AND note = 'แก้ไขการตัดหน่วยซ้ำ REQ-20260831-001: คืน 2 คู่'
  ) THEN RETURN; END IF;

  SELECT id INTO v_wms_id FROM public.wms_orders
  WHERE order_id = 'REQ-20260831-001' AND product_code = '110000413'
  ORDER BY created_at DESC LIMIT 1;
  SELECT id, COALESCE(unit_cost, 0) INTO v_pick_id, v_pick_unit_cost
  FROM public.inv_stock_movements
  WHERE product_id = v_product_id AND ref_type = 'wms_orders' AND ref_id = v_wms_id AND movement_type = 'pick'
  ORDER BY created_at DESC LIMIT 1;

  IF v_pick_id IS NULL THEN
    RAISE NOTICE 'Skip unit correction: pick movement for REQ-20260831-001 not found';
    RETURN;
  END IF;

  FOR v_cons IN
    SELECT lot_id, qty, unit_cost FROM public.inv_lot_consumptions
    WHERE movement_id = v_pick_id ORDER BY created_at DESC
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_restore := LEAST(v_cons.qty, v_remaining);
    UPDATE public.inv_stock_lots SET qty_remaining = qty_remaining + v_restore WHERE id = v_cons.lot_id;
    UPDATE public.inv_lot_consumptions
    SET qty = qty - v_restore
    WHERE movement_id = v_pick_id AND lot_id = v_cons.lot_id;
    v_restored_cost := v_restored_cost + (v_restore * COALESCE(v_cons.unit_cost, v_pick_unit_cost));
    v_remaining := v_remaining - v_restore;
  END LOOP;
  DELETE FROM public.inv_lot_consumptions WHERE movement_id = v_pick_id AND qty <= 0;

  IF v_remaining > 0 THEN
    INSERT INTO public.inv_stock_lots (product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id)
    VALUES (v_product_id, v_remaining, v_remaining, v_pick_unit_cost, 'unit_correction', v_wms_id);
    v_restored_cost := v_restored_cost + (v_remaining * v_pick_unit_cost);
  END IF;

  INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
  VALUES (v_product_id, 2, 0, 0)
  ON CONFLICT (product_id) DO UPDATE
    SET on_hand = COALESCE(public.inv_stock_balances.on_hand, 0) + 2,
        updated_at = NOW();

  INSERT INTO public.inv_stock_movements
    (product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost)
  VALUES
    (v_product_id, 'adjust', 2, 'wms_orders', v_wms_id,
     'แก้ไขการตัดหน่วยซ้ำ REQ-20260831-001: คืน 2 คู่',
     CASE WHEN 2 > 0 THEN v_restored_cost / 2 ELSE v_pick_unit_cost END,
     v_restored_cost);

  PERFORM public.fn_recalc_product_landed_cost(v_product_id);
END;
$$;

COMMENT ON COLUMN public.pr_products.unit_multiplier IS
  'จำนวนชิ้นฐานต่อ 1 หน่วยสินค้า ใช้เพื่ออธิบาย/แปลงหน่วยเท่านั้น ไม่ใช้คูณยอดสต๊อกอัตโนมัติ';
