-- Allow technicians/admins to record the actual date and time a spare part was used.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_use_machinery_part_at(
  p_incident_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_note TEXT,
  p_performed_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.pr_machinery_incidents%ROWTYPE;
  v_balance public.pr_machinery_stock_balances%ROWTYPE;
  v_usage_id UUID;
BEGIN
  IF NOT public.can_use_machinery_spares() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกการใช้อะไหล่';
  END IF;
  IF COALESCE(p_qty,0) <= 0 OR p_qty <> TRUNC(p_qty) THEN
    RAISE EXCEPTION 'จำนวนที่ใช้ต้องเป็นจำนวนเต็มมากกว่า 0';
  END IF;

  SELECT * INTO v_incident
  FROM public.pr_machinery_incidents
  WHERE id = p_incident_id
  FOR UPDATE;

  IF v_incident.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบแจ้งซ่อม'; END IF;
  IF v_incident.status <> 'repairing' THEN
    RAISE EXCEPTION 'บันทึกอะไหล่ได้เมื่อสถานะเป็นกำลังซ่อมเท่านั้น';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.pr_machinery_machine_parts
    WHERE machine_id = v_incident.machine_id
      AND product_id = p_product_id
  ) THEN
    RAISE EXCEPTION 'อะไหล่นี้ไม่ได้กำหนดไว้สำหรับเครื่องจักร';
  END IF;

  SELECT * INTO v_balance
  FROM public.pr_machinery_stock_balances
  WHERE product_id = p_product_id
  FOR UPDATE;

  IF v_balance.product_id IS NULL OR v_balance.qty < p_qty THEN
    RAISE EXCEPTION 'สต๊อกอะไหล่ Machinery ไม่เพียงพอ';
  END IF;

  UPDATE public.pr_machinery_stock_balances
  SET qty = qty - p_qty, updated_at = NOW()
  WHERE product_id = p_product_id;

  INSERT INTO public.pr_machinery_incident_parts(
    incident_id, machine_id, product_id, event_type, qty, unit_cost,
    note, performed_by, performed_at
  ) VALUES (
    p_incident_id, v_incident.machine_id, p_product_id, 'use', p_qty,
    v_balance.average_unit_cost, NULLIF(BTRIM(p_note),''), auth.uid(),
    COALESCE(p_performed_at, NOW())
  ) RETURNING id INTO v_usage_id;

  INSERT INTO public.pr_machinery_stock_moves(
    product_id, qty_delta, movement_type, unit_cost, incident_part_id, note, created_by
  ) VALUES (
    p_product_id, -p_qty, 'part_use', v_balance.average_unit_cost,
    v_usage_id, v_incident.ticket_no, auth.uid()
  );

  RETURN v_usage_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_use_machinery_part_at(UUID,UUID,NUMERIC,TEXT,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_use_machinery_part_at(UUID,UUID,NUMERIC,TEXT,TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.rpc_use_machinery_part_at(UUID,UUID,NUMERIC,TEXT,TIMESTAMPTZ) IS
  'Records spare usage using the operator-specified actual date/time while created_at remains the audit creation time.';

COMMIT;
