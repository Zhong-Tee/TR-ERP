BEGIN;

-- Keep the FIFO lot/cost workflow from migration 099 and extend approval to store.
CREATE OR REPLACE FUNCTION public.approve_return_requisition(
  p_return_id UUID,
  p_user_id   UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role     TEXT;
  v_status   TEXT;
  v_item     RECORD;
  v_avg_cost NUMERIC;
BEGIN
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ผู้ใช้งานไม่ตรงกับ session ปัจจุบัน';
  END IF;

  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติรายการคืน (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.wms_return_requisitions
  WHERE id = p_return_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการคืน'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ไม่อยู่ในสถานะรออนุมัติ (status: %)', v_status;
  END IF;

  FOR v_item IN
    SELECT product_id, qty
    FROM public.wms_return_requisition_items
    WHERE return_requisition_id = p_return_id
  LOOP
    v_avg_cost := public.fn_get_current_avg_cost(v_item.product_id);

    INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
    VALUES (v_item.product_id, v_item.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE
      SET on_hand = inv_stock_balances.on_hand + v_item.qty;

    INSERT INTO public.inv_stock_movements (
      product_id, movement_type, qty, ref_type, ref_id, note, unit_cost, total_cost
    )
    VALUES (
      v_item.product_id, 'return_requisition', v_item.qty,
      'wms_return_requisitions', p_return_id,
      'อนุมัติใบคืน (RPC)', v_avg_cost, v_item.qty * v_avg_cost
    );

    INSERT INTO public.inv_stock_lots (
      product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id
    )
    VALUES (
      v_item.product_id, v_item.qty, v_item.qty, v_avg_cost,
      'wms_return_requisitions', p_return_id
    );

    PERFORM public.fn_recalc_product_landed_cost(v_item.product_id);
  END LOOP;

  UPDATE public.wms_return_requisitions
  SET status = 'approved', approved_by = auth.uid(), approved_at = NOW()
  WHERE id = p_return_id;
END;
$$;

COMMIT;
