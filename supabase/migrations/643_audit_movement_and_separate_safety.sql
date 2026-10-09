BEGIN;

-- Existing records retain their original count interpretation.
ALTER TABLE public.inv_audit_items
  ADD COLUMN count_mode text NOT NULL DEFAULT 'legacy' CHECK (count_mode IN ('legacy','separate')),
  ADD COLUMN product_type text,
  ADD COLUMN system_reserved numeric NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_audit_stock_movement_date_product ON public.inv_stock_movements(created_at, product_id);

CREATE OR REPLACE FUNCTION public.rpc_audit_movement_products(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(product_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND is_active AND role IN ('superadmin','admin','store','sales-tr','account','auditor')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูรายการสินค้า Audit';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN RAISE EXCEPTION 'ช่วงวันที่ไม่ถูกต้อง'; END IF;
  RETURN QUERY
  WITH moved AS (
    SELECT m.product_id FROM inv_stock_movements m
    WHERE m.created_at >= p_from AND m.created_at < p_to
      AND m.movement_type NOT IN ('reserve','unreserve','reservation','release_reservation')
    UNION
    SELECT i.product_id FROM wh_stock_transfer_items i JOIN wh_stock_transfers t ON t.id=i.transfer_id
    WHERE (t.posted_at >= p_from AND t.posted_at < p_to)
       OR (t.cancelled_at >= p_from AND t.cancelled_at < p_to AND t.posted_at IS NOT NULL)
  ), expanded AS (
    SELECT m.product_id FROM moved m
    UNION
    SELECT s.product_id FROM moved m
    JOIN wh_sub_wms_map_sources source ON source.product_id=m.product_id
    JOIN wh_sub_wms_map_spares s ON s.group_id=source.group_id
  )
  SELECT DISTINCT p.id FROM expanded e JOIN pr_products p ON p.id=e.product_id
  WHERE p.is_active AND NOT EXISTS (SELECT 1 FROM roll_material_configs c WHERE c.fg_product_id=p.id)
  ORDER BY p.id;
END;
$$;
REVOKE ALL ON FUNCTION public.rpc_audit_movement_products(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_audit_movement_products(timestamptz,timestamptz) TO authenticated;

CREATE POLICY "Store can view audits" ON public.inv_audits FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY "Store can create audits" ON public.inv_audits FOR INSERT TO authenticated
WITH CHECK (created_by=auth.uid() AND status='in_progress' AND reviewed_by IS NULL AND reviewed_at IS NULL AND completed_at IS NULL AND adjustment_id IS NULL AND EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY "Store can finalize own creation" ON public.inv_audits FOR UPDATE TO authenticated
USING (created_by=auth.uid() AND status='in_progress' AND EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active))
WITH CHECK (created_by=auth.uid() AND status IN ('in_progress','review'));
CREATE POLICY "Store can clean failed creations" ON public.inv_audits FOR DELETE TO authenticated
USING (created_by=auth.uid() AND status='in_progress' AND COALESCE(total_items,0)=0 AND EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY "Store can view audit items" ON public.inv_audit_items FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store' AND is_active));
CREATE POLICY "Store can create own audit items" ON public.inv_audit_items FOR INSERT TO authenticated
WITH CHECK (count_mode='separate' AND EXISTS (SELECT 1 FROM inv_audits a JOIN us_users u ON u.id=auth.uid() WHERE a.id=audit_id AND a.created_by=u.id AND a.status='in_progress' AND u.role='store' AND u.is_active));

-- RLS alone cannot limit which columns an UPDATE changes.
CREATE OR REPLACE FUNCTION public.guard_store_audit_header()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store') AND auth.role() <> 'service_role' THEN
    IF NEW.status NOT IN ('in_progress','review') OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.adjustment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Store ไม่มีสิทธิ์อนุมัติหรือปิด Audit';
    END IF;
    IF (to_jsonb(NEW) - ARRAY['status','total_items','show_system_qty','accuracy_percent','total_variance','location_accuracy_percent','safety_stock_accuracy_percent','total_location_mismatches','total_safety_stock_mismatches']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','total_items','show_system_qty','accuracy_percent','total_variance','location_accuracy_percent','safety_stock_accuracy_percent','total_location_mismatches','total_safety_stock_mismatches']) THEN
      RAISE EXCEPTION 'Store ไม่มีสิทธิ์เปลี่ยนข้อมูลหัวใบ Audit';
    END IF;
    IF NEW.status='review' AND NOT (current_user_can_audit() AND auth.uid()=ANY(COALESCE(OLD.assigned_to,ARRAY[]::uuid[]))) THEN
      RAISE EXCEPTION 'ส่งรีวิวได้เฉพาะผู้ตรวจที่ได้รับมอบหมาย';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_store_audit_header BEFORE UPDATE ON public.inv_audits FOR EACH ROW EXECUTE FUNCTION public.guard_store_audit_header();

-- The legacy adjustment FOR ALL policy includes store. Protect approvals even
-- when a caller bypasses the approval RPC and writes the table directly.
CREATE OR REPLACE FUNCTION public.guard_store_adjustment_approval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role='store') AND auth.role() <> 'service_role' THEN
    IF TG_OP <> 'INSERT' AND (OLD.status='approved' OR OLD.approved_by IS NOT NULL OR OLD.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Store ไม่มีสิทธิ์แก้ไขใบปรับสต๊อคที่อนุมัติแล้ว';
    END IF;
    IF TG_OP <> 'DELETE' AND (NEW.status='approved' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Store ไม่มีสิทธิ์อนุมัติใบปรับสต๊อค';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_store_adjustment_approval BEFORE INSERT OR UPDATE OR DELETE ON public.inv_adjustments FOR EACH ROW EXECUTE FUNCTION public.guard_store_adjustment_approval();

CREATE OR REPLACE FUNCTION public.guard_separate_audit_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.count_mode='separate' THEN
    IF TG_OP='INSERT' AND EXISTS (SELECT 1 FROM roll_material_configs WHERE fg_product_id=NEW.product_id) THEN
      RAISE EXCEPTION 'FG ที่คำนวณจาก RM ไม่ต้องตรวจนับ';
    END IF;
    IF TG_OP='UPDATE' AND (NEW.count_mode IS DISTINCT FROM OLD.count_mode OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.audit_id IS DISTINCT FROM OLD.audit_id OR NEW.system_qty IS DISTINCT FROM OLD.system_qty OR NEW.system_safety_stock IS DISTINCT FROM OLD.system_safety_stock OR NEW.location_snapshot IS DISTINCT FROM OLD.location_snapshot OR NEW.system_reserved IS DISTINCT FROM OLD.system_reserved) THEN
      RAISE EXCEPTION 'ไม่สามารถเปลี่ยน snapshot ของใบ Audit';
    END IF;
    IF NEW.is_counted THEN
      IF NOT EXISTS (SELECT 1 FROM inv_audits WHERE id=NEW.audit_id AND status='in_progress') THEN RAISE EXCEPTION 'ใบ Audit ไม่อยู่ในสถานะนับ'; END IF;
      IF NEW.counted_qty IS NULL OR NEW.counted_qty < 0 OR NEW.counted_qty::text IN ('NaN','Infinity','-Infinity') OR NEW.counted_safety_stock < 0 OR NEW.counted_safety_stock::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'จำนวนตรวจนับไม่ถูกต้อง'; END IF;
      IF NEW.system_safety_stock > 0 AND NEW.counted_safety_stock IS NULL THEN RAISE EXCEPTION 'ต้องกรอก Safety ที่นับได้'; END IF;
      IF NEW.system_safety_stock IS NULL AND NEW.counted_safety_stock IS NOT NULL THEN RAISE EXCEPTION 'ST ใช้ยอดนับรวม ไม่แยก Safety'; END IF;
      NEW.variance := NEW.counted_qty - NEW.system_qty;
      NEW.safety_stock_match := CASE WHEN NEW.counted_safety_stock IS NULL THEN NULL ELSE NEW.counted_safety_stock=COALESCE(NEW.system_safety_stock,0) END;
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.count_mode='separate' THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนรูปแบบการนับ';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_separate_audit_count BEFORE INSERT OR UPDATE ON public.inv_audit_items FOR EACH ROW EXECUTE FUNCTION public.guard_separate_audit_count();

INSERT INTO public.st_user_menus(role,menu_key,menu_name,has_access)
VALUES ('store','warehouse-audit','Audit',true)
ON CONFLICT(role,menu_key) DO UPDATE SET has_access=true,updated_at=now();

COMMIT;
