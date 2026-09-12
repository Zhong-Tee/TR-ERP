BEGIN;

ALTER TABLE public.inv_return_items
  ADD COLUMN IF NOT EXISTS disposition TEXT;

ALTER TABLE public.inv_return_items
  DROP CONSTRAINT IF EXISTS inv_return_items_disposition_check;

ALTER TABLE public.inv_return_items
  ADD CONSTRAINT inv_return_items_disposition_check
  CHECK (disposition IS NULL OR disposition IN ('return_to_stock', 'waste', 'lost'));

CREATE OR REPLACE FUNCTION public.rpc_process_inventory_return_items(
  p_return_id UUID,
  p_items JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role TEXT;
  v_status TEXT;
  v_expected_count INTEGER;
  v_supplied_count INTEGER;
  v_item RECORD;
  v_avg_cost NUMERIC;
  v_parent_disposition TEXT;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดำเนินการสินค้าตีกลับ (role: %)', COALESCE(v_role, 'unknown');
  END IF;

  SELECT status INTO v_status
  FROM public.inv_returns
  WHERE id = p_return_id
  FOR UPDATE;

  IF v_status IS NULL THEN RAISE EXCEPTION 'ไม่พบใบรับสินค้าตีกลับ'; END IF;
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'รายการนี้ดำเนินการแล้ว (status: %)', v_status;
  END IF;

  SELECT count(*) INTO v_expected_count
  FROM public.inv_return_items
  WHERE return_id = p_return_id;

  SELECT count(DISTINCT x.item_id) INTO v_supplied_count
  FROM jsonb_to_recordset(COALESCE(p_items, '[]'::jsonb)) AS x(item_id UUID, disposition TEXT)
  JOIN public.inv_return_items i ON i.id = x.item_id AND i.return_id = p_return_id
  WHERE x.disposition IN ('return_to_stock', 'waste', 'lost');

  IF v_expected_count = 0 OR v_supplied_count <> v_expected_count THEN
    RAISE EXCEPTION 'กรุณาระบุผลตรวจให้ครบทุกสินค้า';
  END IF;

  FOR v_item IN
    SELECT i.id, i.product_id, i.qty, x.disposition
    FROM jsonb_to_recordset(p_items) AS x(item_id UUID, disposition TEXT)
    JOIN public.inv_return_items i ON i.id = x.item_id AND i.return_id = p_return_id
  LOOP
    v_avg_cost := public.fn_get_current_avg_cost(v_item.product_id);

    IF v_item.disposition = 'return_to_stock' THEN
      INSERT INTO public.inv_stock_balances (product_id, on_hand, reserved, safety_stock)
      VALUES (v_item.product_id, v_item.qty, 0, 0)
      ON CONFLICT (product_id) DO UPDATE
        SET on_hand = inv_stock_balances.on_hand + v_item.qty;

      INSERT INTO public.inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost
      ) VALUES (
        v_item.product_id, 'return', v_item.qty, 'inv_returns', p_return_id,
        'สินค้าตีกลับ: คืนกลับสต๊อค', auth.uid(), v_avg_cost, v_item.qty * v_avg_cost
      );

      INSERT INTO public.inv_stock_lots (
        product_id, qty_initial, qty_remaining, unit_cost, ref_type, ref_id
      ) VALUES (
        v_item.product_id, v_item.qty, v_item.qty, v_avg_cost, 'inv_returns', p_return_id
      );

      PERFORM public.fn_recalc_product_landed_cost(v_item.product_id);
    ELSE
      -- Returned goods were already deducted when shipped. Waste/lost must not deduct on_hand again.
      INSERT INTO public.inv_stock_movements (
        product_id, movement_type, qty, ref_type, ref_id, note, created_by, unit_cost, total_cost
      ) VALUES (
        v_item.product_id,
        CASE WHEN v_item.disposition = 'waste' THEN 'return_waste' ELSE 'return_lost' END,
        0, 'inv_returns', p_return_id,
        CASE WHEN v_item.disposition = 'waste'
          THEN format('สินค้าตีกลับ: ของเสีย จำนวน %s', v_item.qty)
          ELSE format('สินค้าตีกลับ: สูญหาย จำนวน %s', v_item.qty)
        END,
        auth.uid(), v_avg_cost, v_item.qty * v_avg_cost
      );
    END IF;

    UPDATE public.inv_return_items
    SET disposition = v_item.disposition
    WHERE id = v_item.id;
  END LOOP;

  SELECT CASE
    WHEN count(DISTINCT disposition) = 1 THEN min(disposition)
    ELSE 'mixed'
  END INTO v_parent_disposition
  FROM public.inv_return_items
  WHERE return_id = p_return_id;

  UPDATE public.inv_returns
  SET status = 'received', disposition = v_parent_disposition,
      received_by = auth.uid(), received_at = NOW()
  WHERE id = p_return_id;
END;
$$;

COMMIT;
