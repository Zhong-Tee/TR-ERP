-- Cancel a pending inventory adjustment without touching stock.

BEGIN;

ALTER TABLE public.inv_adjustments
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

CREATE OR REPLACE FUNCTION public.rpc_cancel_inventory_adjustment(
  p_adjustment_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_adjustment public.inv_adjustments%ROWTYPE;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT u.role INTO v_role
    FROM public.us_users u
    WHERE u.id = auth.uid() AND u.is_active IS TRUE;

    IF v_role IS NULL OR v_role NOT IN ('superadmin', 'admin', 'manager', 'store') THEN
      RAISE EXCEPTION 'Not authorized to cancel an inventory adjustment';
    END IF;
  END IF;

  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Cancellation reason must contain at least 3 characters';
  END IF;

  SELECT * INTO v_adjustment
  FROM public.inv_adjustments
  WHERE id = p_adjustment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory adjustment not found';
  END IF;
  IF v_adjustment.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending inventory adjustment can be cancelled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inv_stock_movements
    WHERE ref_type = 'inv_adjustments' AND ref_id = p_adjustment_id
  ) THEN
    RAISE EXCEPTION 'This adjustment already has stock movements and cannot be cancelled';
  END IF;

  UPDATE public.inv_adjustments
  SET status = 'cancelled',
      cancelled_by = auth.uid(),
      cancelled_at = now(),
      cancel_reason = btrim(p_reason)
  WHERE id = p_adjustment_id;

  RETURN jsonb_build_object(
    'success', true,
    'adjustment_id', p_adjustment_id,
    'adjust_no', v_adjustment.adjust_no,
    'status', 'cancelled'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_inventory_adjustment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_inventory_adjustment(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.rpc_cancel_inventory_adjustment(uuid, text) IS
  'Cancels a pending inventory adjustment only when no stock movement exists, with user/time/reason audit fields.';

COMMIT;
