BEGIN;

-- Preserve the existing rule for old audits; new audits require a full count.
ALTER TABLE public.inv_audits
  ADD COLUMN require_full_count boolean NOT NULL DEFAULT false,
  ADD COLUMN partial_count_reason text,
  ADD COLUMN counted_items integer CHECK (counted_items >= 0);
ALTER TABLE public.inv_audits ALTER COLUMN require_full_count SET DEFAULT true;

-- Recover the original scope from the item rows, including old partial audits.
UPDATE public.inv_audits a
SET total_items = counts.total,
    counted_items = CASE WHEN a.status IN ('review','completed','closed') THEN counts.counted ELSE NULL END
FROM (
  SELECT audit_id, count(*)::integer AS total,
    count(*) FILTER (WHERE is_counted)::integer AS counted
  FROM public.inv_audit_items GROUP BY audit_id
) counts
WHERE a.id = counts.audit_id;

-- The Store guard must permit the two new review-result fields.
DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('public.guard_store_audit_header()'::regprocedure) INTO definition;
  IF position('''total_items'',''show_system_qty''' IN definition) = 0 THEN
    RAISE EXCEPTION 'Cannot update Store Audit review field allowlist';
  END IF;
  EXECUTE replace(definition, '''total_items'',''show_system_qty''',
    '''total_items'',''show_system_qty'',''counted_items'',''partial_count_reason''');
END;
$$;

CREATE FUNCTION public.guard_audit_review_completeness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  scope_count integer;
  counted_count integer;
BEGIN
  -- Decide at creation; a caller cannot disable the rule while submitting.
  IF NEW.require_full_count IS DISTINCT FROM OLD.require_full_count THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนเงื่อนไขนับครบหลังสร้างใบ Audit';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('review','completed','closed') THEN
    IF OLD.status = 'in_progress' AND NEW.status <> 'review' THEN
      RAISE EXCEPTION 'กรุณาส่งรีวิวก่อนปิดการตรวจนับ';
    END IF;
    IF NEW.status = 'review' THEN
      IF OLD.status <> 'in_progress' THEN
        RAISE EXCEPTION 'ใบ Audit ไม่อยู่ในสถานะกำลังนับ';
      END IF;
      SELECT count(*)::integer, count(*) FILTER (WHERE is_counted)::integer
      INTO scope_count, counted_count FROM public.inv_audit_items WHERE audit_id = NEW.id;
      IF counted_count = 0 THEN RAISE EXCEPTION 'ยังไม่มีรายการที่ถูกนับ'; END IF;
      IF NEW.require_full_count AND counted_count < scope_count THEN
        RAISE EXCEPTION 'ต้องตรวจนับครบ 100%% ก่อนส่งรีวิว (เหลือ % รายการ)', scope_count - counted_count;
      END IF;
      IF counted_count < scope_count AND NULLIF(btrim(NEW.partial_count_reason), '') IS NULL THEN
        RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ส่งรีวิวทั้งที่ยังนับไม่ครบ';
      END IF;
      NEW.total_items := scope_count;
      NEW.counted_items := counted_count;
      NEW.partial_count_reason := CASE WHEN counted_count < scope_count THEN btrim(NEW.partial_count_reason) ELSE NULL END;
    END IF;
  END IF;
  IF OLD.status IN ('review','completed','closed') AND (
    NEW.partial_count_reason IS DISTINCT FROM OLD.partial_count_reason
    OR NEW.total_items IS DISTINCT FROM OLD.total_items
    OR NEW.counted_items IS DISTINCT FROM OLD.counted_items
  ) THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนขอบเขตหรือเหตุผลหลังส่งรีวิว';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_audit_review_completeness BEFORE UPDATE ON public.inv_audits
FOR EACH ROW EXECUTE FUNCTION public.guard_audit_review_completeness();

COMMIT;
NOTIFY pgrst, 'reload schema';
