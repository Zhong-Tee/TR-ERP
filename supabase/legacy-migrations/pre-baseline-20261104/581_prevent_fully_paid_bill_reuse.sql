-- Prevent a bill that is already fully funded from being assigned to another
-- Statement transaction. Partial payments remain supported, so one bill may
-- still be paid by multiple slips until its total has been reached.
BEGIN;

CREATE OR REPLACE FUNCTION public.tr_guard_fully_allocated_bank_bill()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bill_no TEXT;
  v_bill_amount NUMERIC(18,2);
  v_allocated_amount NUMERIC(18,2);
BEGIN
  SELECT bill_no, COALESCE(total_amount, 0)
  INTO v_bill_no, v_bill_amount
  FROM public.or_orders
  WHERE id = NEW.order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบบิลที่ต้องการจับคู่';
  END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount), 0)
  INTO v_allocated_amount
  FROM public.ac_bank_reconciliation_allocations allocation
  WHERE allocation.order_id = NEW.order_id
    AND allocation.id IS DISTINCT FROM NEW.id;

  IF v_allocated_amount >= v_bill_amount - 0.01 THEN
    RAISE EXCEPTION 'เลขบิล % ถูกจับคู่ครบแล้ว (ยอดบิล ฿%, จับคู่แล้ว ฿%) กรุณายกเลิกคู่เดิมก่อนหากต้องการเปลี่ยนรายการ',
      v_bill_no,
      to_char(v_bill_amount, 'FM999G999G999G990D00'),
      to_char(v_allocated_amount, 'FM999G999G999G990D00');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_fully_allocated_bank_bill
  ON public.ac_bank_reconciliation_allocations;
CREATE TRIGGER trg_guard_fully_allocated_bank_bill
BEFORE INSERT OR UPDATE OF order_id, allocated_amount
ON public.ac_bank_reconciliation_allocations
FOR EACH ROW EXECUTE FUNCTION public.tr_guard_fully_allocated_bank_bill();

CREATE OR REPLACE FUNCTION public.bank_reconciliation_bill_match_availability(p_bill_no TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.or_orders;
  v_allocated_amount NUMERIC(18,2);
BEGIN
  PERFORM public.bank_reconciliation_require_authorized_role();

  SELECT * INTO v_order
  FROM public.or_orders
  WHERE upper(trim(bill_no)) = upper(trim(p_bill_no))
    AND status <> 'ยกเลิก'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบบิล หรือบิลถูกยกเลิก';
  END IF;

  SELECT COALESCE(SUM(allocation.allocated_amount), 0)
  INTO v_allocated_amount
  FROM public.ac_bank_reconciliation_allocations allocation
  WHERE allocation.order_id = v_order.id;

  RETURN jsonb_build_object(
    'available', v_allocated_amount < COALESCE(v_order.total_amount, 0) - 0.01,
    'order_id', v_order.id,
    'bill_no', v_order.bill_no,
    'bill_amount', COALESCE(v_order.total_amount, 0),
    'allocated_amount', v_allocated_amount,
    'remaining_amount', GREATEST(COALESCE(v_order.total_amount, 0) - v_allocated_amount, 0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bank_reconciliation_bill_match_availability(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_reconciliation_bill_match_availability(TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
