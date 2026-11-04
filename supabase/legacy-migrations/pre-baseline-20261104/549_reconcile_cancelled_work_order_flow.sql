-- Keep cancellation stock handling, work-order headers, Plan and notifications
-- in one consistent state. This migration is intentionally idempotent.

ALTER TABLE public.wms_orders
  ADD COLUMN IF NOT EXISTS stock_action_by UUID REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS stock_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS returned_to_shelf_by UUID REFERENCES public.us_users(id),
  ADD COLUMN IF NOT EXISTS returned_to_shelf_at TIMESTAMPTZ;

ALTER TABLE public.or_work_orders
  ADD COLUMN IF NOT EXISTS cancellation_state TEXT;

COMMENT ON COLUMN public.or_work_orders.cancellation_state IS
  'NULL/active, pending_stock, awaiting_shelf or closed; derived by reconcile_work_order_after_cancellation.';

CREATE OR REPLACE FUNCTION public.trg_audit_wms_cancellation_action()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.stock_action IS DISTINCT FROM OLD.stock_action AND NEW.stock_action IS NOT NULL THEN
    NEW.stock_action_by := COALESCE(NEW.stock_action_by, auth.uid());
    NEW.stock_action_at := COALESCE(NEW.stock_action_at, NOW());
  END IF;

  IF NEW.status = 'returned' AND OLD.status IS DISTINCT FROM 'returned' THEN
    NEW.returned_to_shelf_by := COALESCE(NEW.returned_to_shelf_by, auth.uid());
    NEW.returned_to_shelf_at := COALESCE(NEW.returned_to_shelf_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_wms_cancellation_action ON public.wms_orders;
CREATE TRIGGER trg_audit_wms_cancellation_action
BEFORE UPDATE OF stock_action, status ON public.wms_orders
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_wms_cancellation_action();

CREATE OR REPLACE FUNCTION public.reconcile_work_order_after_cancellation(p_work_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wo public.or_work_orders%ROWTYPE;
  v_active_orders INTEGER := 0;
  v_active_items INTEGER := 0;
  v_pending_stock INTEGER := 0;
  v_awaiting_shelf INTEGER := 0;
  v_cancelled_rows INTEGER := 0;
  v_state TEXT := NULL;
  v_status TEXT;
BEGIN
  IF p_work_order_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_work_order_id');
  END IF;

  SELECT * INTO v_wo
  FROM public.or_work_orders
  WHERE id = p_work_order_id
  FOR UPDATE;

  IF v_wo.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'work_order_not_found');
  END IF;

  SELECT COUNT(*)::INTEGER
  INTO v_active_items
  FROM public.or_order_items oi
  JOIN public.or_orders o ON o.id = oi.order_id
  WHERE (o.work_order_id = v_wo.id OR (o.work_order_id IS NULL AND BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(v_wo.work_order_name)))
    AND COALESCE(o.status, '') <> 'ยกเลิก'
    AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL;

  SELECT COUNT(*)::INTEGER
  INTO v_active_orders
  FROM public.or_orders o
  WHERE (o.work_order_id = v_wo.id OR (o.work_order_id IS NULL AND BTRIM(COALESCE(o.work_order_name, '')) = BTRIM(v_wo.work_order_name)))
    AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'จัดส่งแล้ว')
    AND EXISTS (
      SELECT 1 FROM public.or_order_items oi
      WHERE oi.order_id = o.id
        AND NULLIF(BTRIM(COALESCE(oi.cancellation_stock_action, '')), '') IS NULL
    );

  SELECT
    COUNT(*) FILTER (WHERE w.status = 'cancelled' AND w.stock_action IS NULL)::INTEGER,
    COUNT(*) FILTER (WHERE w.status = 'cancelled' AND w.stock_action = 'recalled')::INTEGER,
    COUNT(*)::INTEGER
  INTO v_pending_stock, v_awaiting_shelf, v_cancelled_rows
  FROM public.wms_orders w
  WHERE (w.work_order_id = v_wo.id OR (w.work_order_id IS NULL AND BTRIM(COALESCE(w.order_id, '')) = BTRIM(v_wo.work_order_name)))
    AND (w.status = 'cancelled' OR w.stock_action IN ('recalled', 'waste'));

  IF v_pending_stock > 0 THEN
    v_state := 'pending_stock';
  ELSIF v_awaiting_shelf > 0 THEN
    v_state := 'awaiting_shelf';
  ELSIF v_cancelled_rows > 0 OR v_active_items = 0 THEN
    v_state := 'closed';
  END IF;

  IF v_active_orders > 0 THEN
    v_status := CASE
      WHEN v_wo.status IN ('รอจัดการสต๊อก', 'รอคืนเข้าชั้น', 'จัดส่งแล้ว', 'ยกเลิก') THEN 'กำลังผลิต'
      ELSE v_wo.status
    END;
  ELSIF v_pending_stock > 0 THEN
    v_status := 'รอจัดการสต๊อก';
  ELSIF v_awaiting_shelf > 0 THEN
    v_status := 'รอคืนเข้าชั้น';
  ELSIF v_active_items > 0 THEN
    -- There are real items, but every remaining bill has already shipped.
    v_status := 'จัดส่งแล้ว';
  ELSE
    v_status := 'ยกเลิก';
  END IF;

  UPDATE public.or_work_orders
  SET order_count = v_active_orders,
      status = v_status,
      cancellation_state = v_state,
      plan_wo_modified = TRUE,
      updated_at = NOW()
  WHERE id = v_wo.id;

  -- A zero-active-item job must no longer look actionable in production/QC/PACK.
  -- Keep tracks intact for audit and let Plan render the row as cancelled/skipped.
  IF v_active_items = 0 THEN
    UPDATE public.plan_jobs
    SET is_production_voided = TRUE
    WHERE work_order_id = v_wo.id OR (work_order_id IS NULL AND name = v_wo.work_order_name);
  END IF;

  -- Cancellation notifications are lifecycle records. Once the stock decision
  -- is complete they leave the generic queue; physical shelf return remains
  -- visible through cancellation history and the WMS review queue.
  IF v_pending_stock = 0 THEN
    UPDATE public.wms_notifications
    SET status = 'fixed', is_read = TRUE
    WHERE type = 'ยกเลิกบิล'
      AND BTRIM(COALESCE(order_id, '')) = BTRIM(v_wo.work_order_name);
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'work_order_id', v_wo.id,
    'work_order_name', v_wo.work_order_name,
    'status', v_status,
    'cancellation_state', v_state,
    'active_orders', v_active_orders,
    'active_items', v_active_items,
    'pending_stock', v_pending_stock,
    'awaiting_shelf', v_awaiting_shelf
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reconcile_work_order_after_cancellation(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.trg_reconcile_wms_cancelled_work_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_work_order_id UUID;
BEGIN
  v_work_order_id := NEW.work_order_id;
  IF v_work_order_id IS NULL THEN
    SELECT id INTO v_work_order_id
    FROM public.or_work_orders
    WHERE BTRIM(work_order_name) = BTRIM(COALESCE(NEW.order_id, ''))
    ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_work_order_id IS NOT NULL THEN
    PERFORM public.reconcile_work_order_after_cancellation(v_work_order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_wms_cancelled_work_order ON public.wms_orders;
CREATE TRIGGER trg_reconcile_wms_cancelled_work_order
AFTER INSERT OR UPDATE OF status, stock_action ON public.wms_orders
FOR EACH ROW
WHEN (NEW.status = 'cancelled' OR NEW.status = 'returned' OR NEW.stock_action IS NOT NULL)
EXECUTE FUNCTION public.trg_reconcile_wms_cancelled_work_order();

CREATE OR REPLACE FUNCTION public.trg_reconcile_order_cancellation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_work_order_id UUID;
BEGIN
  SELECT o.work_order_id INTO v_work_order_id
  FROM public.or_orders o WHERE o.id = NEW.order_id;
  IF v_work_order_id IS NOT NULL THEN
    PERFORM public.reconcile_work_order_after_cancellation(v_work_order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_order_item_cancellation ON public.or_order_items;
CREATE TRIGGER trg_reconcile_order_item_cancellation
AFTER UPDATE OF cancellation_stock_action ON public.or_order_items
FOR EACH ROW
WHEN (NEW.cancellation_stock_action IS DISTINCT FROM OLD.cancellation_stock_action)
EXECUTE FUNCTION public.trg_reconcile_order_cancellation();

CREATE OR REPLACE FUNCTION public.trg_reconcile_finalized_work_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.reconcile_work_order_after_cancellation(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reconcile_finalized_work_order ON public.or_work_orders;
CREATE TRIGGER trg_reconcile_finalized_work_order
AFTER UPDATE OF status ON public.or_work_orders
FOR EACH ROW
WHEN (NEW.status = 'จัดส่งแล้ว' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.trg_reconcile_finalized_work_order();

-- Repair existing work orders that already have cancellation rows.
DO $$
DECLARE
  v_id UUID;
BEGIN
  FOR v_id IN
    SELECT DISTINCT wo.id
    FROM public.or_work_orders wo
    JOIN public.wms_orders w
      ON w.work_order_id = wo.id
      OR (w.work_order_id IS NULL AND BTRIM(COALESCE(w.order_id, '')) = BTRIM(wo.work_order_name))
    WHERE w.status IN ('cancelled', 'returned') OR w.stock_action IN ('recalled', 'waste')
  LOOP
    PERFORM public.reconcile_work_order_after_cancellation(v_id);
  END LOOP;
END;
$$;
