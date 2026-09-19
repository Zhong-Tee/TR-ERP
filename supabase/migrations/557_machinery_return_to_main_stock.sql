-- Return unused Machinery spare stock to the main warehouse with approval.

BEGIN;

ALTER TABLE public.pr_machinery_stock_transfers
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'to_machinery';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.pr_machinery_stock_transfers'::regclass
      AND conname = 'pr_machinery_stock_transfers_direction_check'
  ) THEN
    ALTER TABLE public.pr_machinery_stock_transfers
      ADD CONSTRAINT pr_machinery_stock_transfers_direction_check
      CHECK (direction IN ('to_machinery', 'to_main'));
  END IF;
END;
$$;

ALTER TABLE public.pr_machinery_stock_moves
  DROP CONSTRAINT IF EXISTS pr_machinery_stock_moves_movement_type_check;
ALTER TABLE public.pr_machinery_stock_moves
  ADD CONSTRAINT pr_machinery_stock_moves_movement_type_check
  CHECK (movement_type IN ('transfer_in','transfer_out','part_use','part_return'));

CREATE OR REPLACE FUNCTION public.rpc_request_machinery_stock_return(
  p_product_id UUID,
  p_qty NUMERIC,
  p_note TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
  v_available NUMERIC := 0;
BEGIN
  IF NOT public.can_manage_machinery_spares_all() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างคำขอคืนอะไหล่เข้าคลังหลัก';
  END IF;
  IF COALESCE(p_qty,0) <= 0 OR p_qty <> TRUNC(p_qty) THEN
    RAISE EXCEPTION 'จำนวนที่ขอคืนต้องเป็นจำนวนเต็มมากกว่า 0';
  END IF;

  SELECT COALESCE(qty,0)
  INTO v_available
  FROM public.pr_machinery_stock_balances
  WHERE product_id = p_product_id;

  IF v_available < p_qty THEN
    RAISE EXCEPTION 'สต๊อก Machinery ไม่เพียงพอสำหรับการคืน';
  END IF;

  INSERT INTO public.pr_machinery_stock_transfers(
    transfer_no, product_id, qty, direction, note, requested_by
  ) VALUES (
    public.fn_next_machinery_transfer_no(), p_product_id, p_qty, 'to_main',
    NULLIF(BTRIM(p_note),''), auth.uid()
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_confirm_machinery_stock_transfer(p_transfer_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_transfer public.pr_machinery_stock_transfers%ROWTYPE;
  v_main_balance public.inv_stock_balances%ROWTYPE;
  v_machinery_balance public.pr_machinery_stock_balances%ROWTYPE;
  v_movement_id UUID;
  v_unit_cost NUMERIC := 0;
BEGIN
  IF NOT public.can_confirm_machinery_stock_transfer() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันการโอนสต๊อก';
  END IF;

  SELECT * INTO v_transfer
  FROM public.pr_machinery_stock_transfers
  WHERE id = p_transfer_id
  FOR UPDATE;

  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการโอน'; END IF;
  IF v_transfer.status <> 'pending' THEN RAISE EXCEPTION 'รายการนี้ถูกดำเนินการแล้ว'; END IF;

  IF v_transfer.direction = 'to_main' THEN
    SELECT * INTO v_machinery_balance
    FROM public.pr_machinery_stock_balances
    WHERE product_id = v_transfer.product_id
    FOR UPDATE;

    IF v_machinery_balance.product_id IS NULL OR v_machinery_balance.qty < v_transfer.qty THEN
      RAISE EXCEPTION 'สต๊อก Machinery ไม่เพียงพอสำหรับการคืน';
    END IF;

    v_unit_cost := COALESCE(v_machinery_balance.average_unit_cost,0);

    UPDATE public.pr_machinery_stock_balances
    SET qty = qty - v_transfer.qty, updated_at = NOW()
    WHERE product_id = v_transfer.product_id;

    INSERT INTO public.inv_stock_balances(product_id, on_hand, reserved, safety_stock)
    VALUES (v_transfer.product_id, v_transfer.qty, 0, 0)
    ON CONFLICT (product_id) DO UPDATE SET
      on_hand = COALESCE(public.inv_stock_balances.on_hand,0) + EXCLUDED.on_hand,
      updated_at = NOW();

    INSERT INTO public.inv_stock_movements(
      product_id, movement_type, qty, ref_type, ref_id, note,
      unit_cost, total_cost, created_by
    ) VALUES (
      v_transfer.product_id, 'machinery_return_in', v_transfer.qty,
      'pr_machinery_stock_transfers', v_transfer.id,
      'รับคืนจากคลังอะไหล่ Machinery ' || v_transfer.transfer_no,
      v_unit_cost, v_transfer.qty * v_unit_cost, auth.uid()
    ) RETURNING id INTO v_movement_id;

    INSERT INTO public.inv_stock_lots(
      product_id, qty_initial, qty_remaining, unit_cost,
      ref_type, ref_id, is_safety_stock
    ) VALUES (
      v_transfer.product_id, v_transfer.qty, v_transfer.qty, v_unit_cost,
      'pr_machinery_stock_transfers', v_transfer.id, FALSE
    );

    INSERT INTO public.pr_machinery_stock_moves(
      product_id, qty_delta, movement_type, unit_cost, transfer_id, note, created_by
    ) VALUES (
      v_transfer.product_id, -v_transfer.qty, 'transfer_out', v_unit_cost,
      v_transfer.id, v_transfer.transfer_no, auth.uid()
    );
  ELSE
    SELECT * INTO v_main_balance
    FROM public.inv_stock_balances
    WHERE product_id = v_transfer.product_id
    FOR UPDATE;

    IF v_main_balance.id IS NULL
       OR COALESCE(v_main_balance.on_hand,0) - COALESCE(v_main_balance.reserved,0) < v_transfer.qty THEN
      RAISE EXCEPTION 'สต๊อกหลักที่พร้อมใช้ไม่เพียงพอ';
    END IF;

    PERFORM public.fn_reconcile_sellable_lots_to_on_hand(v_transfer.product_id);
    UPDATE public.inv_stock_balances
    SET on_hand = on_hand - v_transfer.qty, updated_at = NOW()
    WHERE product_id = v_transfer.product_id;

    INSERT INTO public.inv_stock_movements(
      product_id, movement_type, qty, ref_type, ref_id, note, created_by
    ) VALUES (
      v_transfer.product_id, 'machinery_transfer_out', -v_transfer.qty,
      'pr_machinery_stock_transfers', v_transfer.id,
      'โอนเข้าคลังอะไหล่ Machinery ' || v_transfer.transfer_no, auth.uid()
    ) RETURNING id INTO v_movement_id;

    PERFORM public.fn_consume_stock_fifo(v_transfer.product_id, v_transfer.qty, v_movement_id);
    SELECT COALESCE(unit_cost,0) INTO v_unit_cost
    FROM public.inv_stock_movements
    WHERE id = v_movement_id;

    INSERT INTO public.pr_machinery_stock_balances(product_id, qty, average_unit_cost)
    VALUES (v_transfer.product_id, v_transfer.qty, v_unit_cost)
    ON CONFLICT (product_id) DO UPDATE SET
      average_unit_cost = CASE
        WHEN public.pr_machinery_stock_balances.qty + EXCLUDED.qty > 0 THEN
          ((public.pr_machinery_stock_balances.qty * public.pr_machinery_stock_balances.average_unit_cost)
            + (EXCLUDED.qty * EXCLUDED.average_unit_cost))
          / (public.pr_machinery_stock_balances.qty + EXCLUDED.qty)
        ELSE 0 END,
      qty = public.pr_machinery_stock_balances.qty + EXCLUDED.qty,
      updated_at = NOW();

    INSERT INTO public.pr_machinery_stock_moves(
      product_id, qty_delta, movement_type, unit_cost, transfer_id, note, created_by
    ) VALUES (
      v_transfer.product_id, v_transfer.qty, 'transfer_in', v_unit_cost,
      v_transfer.id, v_transfer.transfer_no, auth.uid()
    );
  END IF;

  UPDATE public.pr_machinery_stock_transfers
  SET status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = NOW(),
      main_stock_movement_id = v_movement_id, updated_at = NOW()
  WHERE id = v_transfer.id;

  PERFORM public.fn_recalc_product_landed_cost(v_transfer.product_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_request_machinery_stock_return(UUID,NUMERIC,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_request_machinery_stock_return(UUID,NUMERIC,TEXT) TO authenticated;

COMMENT ON COLUMN public.pr_machinery_stock_transfers.direction IS
  'to_machinery transfers main Movement stock into Machinery; to_main returns Machinery stock to main Movement stock.';

COMMIT;
