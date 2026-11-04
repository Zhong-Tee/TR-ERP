-- เก็บรายการ "ตรวจสอบไม่ผ่าน" เข้าประวัติโดยไม่ลบบิล สลิป หรือ Audit trail
BEGIN;
ALTER TABLE public.or_orders
  ADD COLUMN IF NOT EXISTS failed_queue_archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_queue_archived_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failed_queue_archived_by_name TEXT,
  ADD COLUMN IF NOT EXISTS failed_queue_archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_or_orders_failed_queue_archived_at
  ON public.or_orders(failed_queue_archived_at);

-- ถ้าบิลเปลี่ยนเข้าสถานะตรวจไม่ผ่านรอบใหม่ ให้นำกลับเข้าคิวอัตโนมัติ
CREATE OR REPLACE FUNCTION public.reopen_order_failed_queue_on_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('ตรวจสอบไม่ผ่าน', 'ตรวจสอบไม่สำเร็จ')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.failed_queue_archived_at := NULL;
    NEW.failed_queue_archived_by := NULL;
    NEW.failed_queue_archived_by_name := NULL;
    NEW.failed_queue_archive_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reopen_order_failed_queue_on_status ON public.or_orders;
CREATE TRIGGER trg_reopen_order_failed_queue_on_status
  BEFORE UPDATE OF status ON public.or_orders
  FOR EACH ROW EXECUTE FUNCTION public.reopen_order_failed_queue_on_status();

CREATE OR REPLACE FUNCTION public.reopen_order_failed_queue(p_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.or_orders
  SET failed_queue_archived_at = NULL,
      failed_queue_archived_by = NULL,
      failed_queue_archived_by_name = NULL,
      failed_queue_archive_reason = NULL
  WHERE id = p_order_id
    AND failed_queue_archived_at IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.reopen_order_failed_queue(UUID) FROM PUBLIC, anon, authenticated;

-- การเก็บเข้าประวัติทำได้เฉพาะ superadmin, admin และ account
CREATE OR REPLACE FUNCTION public.guard_order_failed_queue_archive()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.failed_queue_archived_at IS NOT NULL
     AND OLD.failed_queue_archived_at IS DISTINCT FROM NEW.failed_queue_archived_at
     AND NOT EXISTS (
       SELECT 1 FROM public.us_users
       WHERE id = auth.uid()
         AND role IN ('superadmin', 'admin', 'account')
     ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เก็บรายการตรวจสอบไม่ผ่านเข้าประวัติ';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_order_failed_queue_archive ON public.or_orders;
CREATE TRIGGER trg_guard_order_failed_queue_archive
  BEFORE UPDATE OF failed_queue_archived_at ON public.or_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_order_failed_queue_archive();

-- ส่งตรวจสลิปมือรอบใหม่ หรือผลถูกปฏิเสธรอบใหม่
CREATE OR REPLACE FUNCTION public.reopen_failed_queue_from_manual_slip()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.reopen_order_failed_queue(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reopen_failed_queue_from_manual_slip ON public.ac_manual_slip_checks;
CREATE TRIGGER trg_reopen_failed_queue_from_manual_slip
  AFTER INSERT OR UPDATE OF status ON public.ac_manual_slip_checks
  FOR EACH ROW EXECUTE FUNCTION public.reopen_failed_queue_from_manual_slip();

-- รายการโอนคืนรอบใหม่/ถูกปฏิเสธรอบใหม่
CREATE OR REPLACE FUNCTION public.reopen_failed_queue_from_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.reason ILIKE '%โอนเกิน%'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM public.reopen_order_failed_queue(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reopen_failed_queue_from_refund ON public.ac_refunds;
CREATE TRIGGER trg_reopen_failed_queue_from_refund
  AFTER INSERT OR UPDATE OF status ON public.ac_refunds
  FOR EACH ROW EXECUTE FUNCTION public.reopen_failed_queue_from_refund();

-- ผลตรวจ EasySlip ไม่ผ่านรอบใหม่ แม้สถานะบิลเดิมยังเป็นตรวจไม่ผ่านอยู่
CREATE OR REPLACE FUNCTION public.reopen_failed_queue_from_slip_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'failed' THEN
    PERFORM public.reopen_order_failed_queue(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_reopen_failed_queue_from_slip_log ON public.ac_slip_verification_logs;
CREATE TRIGGER trg_reopen_failed_queue_from_slip_log
  AFTER INSERT ON public.ac_slip_verification_logs
  FOR EACH ROW EXECUTE FUNCTION public.reopen_failed_queue_from_slip_log();

COMMIT;
