BEGIN;

-- Location stock represents movable (on_hand) stock only. Migration 545 seeded
-- it with on_hand + safety_stock, which made the location drawer overstate the
-- amount that can be moved. Reconcile every location ledger to on_hand while
-- preserving the user's location split as far as possible.

-- Stock movements can include Safety stock entries, while a Safety reclass can
-- change on_hand without creating a movement. Sync from the on_hand source of
-- truth so future Safety changes never leak into physical location quantities.
DROP TRIGGER IF EXISTS sync_location_stock_from_movement ON public.inv_stock_movements;

CREATE OR REPLACE FUNCTION public.trg_sync_location_stock_from_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_previous_on_hand NUMERIC := 0;
  v_delta NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_previous_on_hand := COALESCE(OLD.on_hand, 0);
  END IF;

  v_delta := COALESCE(NEW.on_hand, 0) - v_previous_on_hand;
  IF v_delta <> 0 THEN
    PERFORM public.fn_apply_location_stock_delta(NEW.product_id, v_delta);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_location_stock_from_balance ON public.inv_stock_balances;
CREATE TRIGGER sync_location_stock_from_balance
AFTER INSERT OR UPDATE OF on_hand ON public.inv_stock_balances
FOR EACH ROW
EXECUTE FUNCTION public.trg_sync_location_stock_from_balance();

DO $$
DECLARE
  v_product RECORD;
  v_location_total NUMERIC;
  v_delta NUMERIC;
BEGIN
  FOR v_product IN
    SELECT
      product_ids.product_id,
      GREATEST(COALESCE(balance.on_hand, 0), 0) AS movement_qty
    FROM (
      SELECT product_id FROM public.inv_stock_balances
      UNION
      SELECT product_id FROM public.wh_location_stock
    ) product_ids
    LEFT JOIN public.inv_stock_balances balance
      ON balance.product_id = product_ids.product_id
  LOOP
    SELECT COALESCE(SUM(stock.qty), 0)
    INTO v_location_total
    FROM public.wh_location_stock stock
    WHERE stock.product_id = v_product.product_id;

    v_delta := v_product.movement_qty - v_location_total;
    IF v_delta <> 0 THEN
      PERFORM public.fn_apply_location_stock_delta(v_product.product_id, v_delta);
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.wh_location_stock IS
  'Physical location allocation of movable on_hand stock; safety stock is tracked separately in inv_stock_balances.';

COMMIT;
