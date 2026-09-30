-- Approved receiving closures. Quantities received and stock are never fabricated.
BEGIN;

CREATE OR REPLACE FUNCTION public.erp_can_view_cost() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM us_users WHERE id = auth.uid() AND role IN ('superadmin','admin','account'));
$$;

CREATE OR REPLACE FUNCTION public.erp_can_manage_receiving_cases() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM us_users u WHERE u.id = auth.uid() AND
    (u.role IN ('superadmin','admin','account') OR coalesce(
      (SELECT m.has_access FROM st_user_menus m WHERE m.role=u.role AND m.menu_key='purchase-gr'),
      (SELECT m.has_access FROM st_user_menus m WHERE m.role=u.role AND m.menu_key='purchase'),false)));
$$;
REVOKE ALL ON FUNCTION public.erp_can_manage_receiving_cases() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.erp_can_manage_receiving_cases() TO authenticated;

CREATE FUNCTION public.rpc_receiving_case_users() RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT u.id,coalesce(nullif(u.username,''),u.id::text) FROM us_users u
  WHERE public.erp_can_manage_receiving_cases() ORDER BY u.username;
$$;
REVOKE ALL ON FUNCTION public.rpc_receiving_case_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_receiving_case_users() TO authenticated;

CREATE TABLE public.inv_receiving_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  po_id uuid NOT NULL REFERENCES public.inv_po(id),
  method text NOT NULL CHECK (method IN ('refund','cancel_unpaid','vendor_refused','dispute')),
  status text NOT NULL CHECK (status IN ('pending','refund_pending','adjustment_pending','dispute','completed','rejected')),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  assigned_to uuid NOT NULL REFERENCES public.us_users(id),
  created_by uuid NOT NULL REFERENCES public.us_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES public.us_users(id),
  approved_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.inv_receiving_cases(po_id, status);
CREATE TABLE public.inv_receiving_case_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.inv_receiving_cases(id),
  po_item_id uuid NOT NULL REFERENCES public.inv_po_items(id),
  qty numeric(12,2) NOT NULL CHECK (qty > 0),
  UNIQUE(case_id, po_item_id)
);
CREATE TABLE public.inv_receiving_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.inv_receiving_cases(id),
  action text NOT NULL,
  note text NOT NULL DEFAULT '',
  actor_id uuid NOT NULL REFERENCES public.us_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Financial amounts and evidence have separate access rules from operational history.
CREATE TABLE public.inv_receiving_case_finance (
  case_id uuid PRIMARY KEY REFERENCES public.inv_receiving_cases(id),
  expected_amount numeric(14,2) NOT NULL CHECK (expected_amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  settled_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0 AND settled_amount <= expected_amount)
);
CREATE TABLE public.inv_receiving_case_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.inv_receiving_cases(id),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reference text NOT NULL CHECK (length(btrim(reference)) > 0),
  settled_on date NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.us_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id, reference)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inv_receiving_cases','inv_receiving_case_items','inv_receiving_case_events','inv_receiving_case_finance','inv_receiving_case_settlements'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY receiving_case_read ON public.%I FOR SELECT TO authenticated USING (%s)', t,
      CASE WHEN t IN ('inv_receiving_case_finance','inv_receiving_case_settlements') THEN 'public.erp_can_view_cost()' ELSE 'public.erp_can_manage_receiving_cases()' END);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_create_receiving_case(
  p_po_id uuid, p_method text, p_reason text, p_items jsonb, p_assigned_to uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_item jsonb; v_po_item inv_po_items%ROWTYPE; v_reserved numeric; v_qty numeric;
BEGIN
  IF NOT public.erp_can_manage_receiving_cases() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการยอดค้างรับ'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('refund','cancel_unpaid','vendor_refused','dispute') OR nullif(btrim(p_reason),'') IS NULL THEN
    RAISE EXCEPTION 'กรุณาระบุวิธีจัดการและเหตุผล';
  END IF;
  PERFORM 1 FROM inv_po WHERE id = p_po_id AND status IN ('ordered','partial') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PO ไม่อยู่ในสถานะที่จัดการยอดค้างรับได้'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'กรุณาเลือกรายการ'; END IF;
  IF p_assigned_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM us_users WHERE id = p_assigned_to) THEN RAISE EXCEPTION 'ไม่พบผู้รับผิดชอบ'; END IF;
  INSERT INTO inv_receiving_cases(po_id,method,status,reason,assigned_to,created_by)
    VALUES(p_po_id,p_method,CASE WHEN p_method = 'dispute' THEN 'dispute' ELSE 'pending' END,btrim(p_reason),coalesce(p_assigned_to,auth.uid()),auth.uid()) RETURNING id INTO v_id;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_po_item FROM inv_po_items WHERE id = (v_item->>'po_item_id')::uuid AND po_id = p_po_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'รายการไม่อยู่ใน PO'; END IF;
    v_qty := (v_item->>'qty')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> round(v_qty,2) OR v_qty::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'จำนวนไม่ถูกต้อง'; END IF;
    SELECT coalesce(sum(i.qty),0) INTO v_reserved FROM inv_receiving_case_items i JOIN inv_receiving_cases c ON c.id=i.case_id
      WHERE i.po_item_id=v_po_item.id AND c.status IN ('pending','dispute');
    IF v_qty > v_po_item.qty - coalesce(v_po_item.qty_received_total,0) - coalesce(v_po_item.resolution_qty,0) - v_reserved THEN
      RAISE EXCEPTION 'จำนวนเกินยอดค้างรับที่ยังไม่มีคำขอ กรุณาโหลดข้อมูลใหม่';
    END IF;
    INSERT INTO inv_receiving_case_items(case_id,po_item_id,qty) VALUES(v_id,v_po_item.id,v_qty);
  END LOOP;
  INSERT INTO inv_receiving_case_events(case_id,action,note,actor_id) VALUES(v_id,'created',p_method,auth.uid());
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_receiving_case_action(p_case_id uuid,p_action text,p_data jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c inv_receiving_cases%ROWTYPE; f inv_receiving_case_finance%ROWTYPE; i record; v_po uuid; v_note text := coalesce(p_data->>'note',''); v_amount numeric; v_method text;
BEGIN
  IF NOT public.erp_can_manage_receiving_cases() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์จัดการยอดค้างรับ'; END IF;
  SELECT po_id INTO v_po FROM inv_receiving_cases WHERE id=p_case_id;
  IF v_po IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการติดตาม'; END IF;
  -- Same lock order as receiving and case creation: PO, case, PO items.
  PERFORM 1 FROM inv_po WHERE id=v_po FOR UPDATE;
  SELECT * INTO c FROM inv_receiving_cases WHERE id=p_case_id FOR UPDATE;
  IF p_action IN ('approve','reject','settle') AND NOT public.erp_can_view_cost() THEN RAISE EXCEPTION 'เฉพาะ superadmin, admin, account'; END IF;
  IF p_action = 'approve' THEN
    IF c.status <> 'pending' THEN RAISE EXCEPTION 'รายการไม่ได้รออนุมัติ'; END IF;
    IF NOT EXISTS (SELECT 1 FROM inv_po WHERE id=v_po AND status IN ('ordered','partial')) THEN RAISE EXCEPTION 'สถานะ PO เปลี่ยนแล้ว'; END IF;
    FOR i IN SELECT ci.qty requested_qty, poi.* FROM inv_receiving_case_items ci JOIN inv_po_items poi ON poi.id=ci.po_item_id WHERE ci.case_id=c.id ORDER BY poi.id FOR UPDATE OF poi LOOP
      IF i.requested_qty > i.qty - coalesce(i.qty_received_total,0) - coalesce(i.resolution_qty,0) THEN RAISE EXCEPTION 'มีการรับสินค้าเพิ่มแล้ว กรุณาปฏิเสธคำขอนี้และสร้างใหม่ตามยอดปัจจุบัน'; END IF;
      UPDATE inv_po_items SET resolution_qty=coalesce(resolution_qty,0)+i.requested_qty,
        resolution_type=CASE c.method WHEN 'cancel_unpaid' THEN 'cancelled' WHEN 'vendor_refused' THEN 'vendor_refused' ELSE 'refund' END,
        resolution_note=c.reason,resolved_by=auth.uid(),resolved_at=now() WHERE id=i.id;
    END LOOP;
    IF c.method IN ('refund','cancel_unpaid') THEN
      v_amount := (p_data->>'amount')::numeric;
      IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount,2) OR v_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'ระบุยอดเงินตามข้อตกลงให้ถูกต้อง'; END IF;
      INSERT INTO inv_receiving_case_finance(case_id,expected_amount,currency) VALUES(c.id,v_amount,upper(p_data->>'currency'));
    END IF;
    UPDATE inv_receiving_cases SET approved_by=auth.uid(),approved_at=now(),
      status=CASE c.method WHEN 'refund' THEN 'refund_pending' WHEN 'cancel_unpaid' THEN 'adjustment_pending' ELSE 'completed' END,
      completed_at=CASE WHEN c.method='vendor_refused' THEN now() ELSE NULL END WHERE id=c.id;
    IF NOT EXISTS (SELECT 1 FROM inv_po_items WHERE po_id=v_po AND qty > coalesce(qty_received_total,0)+coalesce(resolution_qty,0)) THEN
      UPDATE inv_po SET status='closed',updated_at=now() WHERE id=v_po;
    END IF;
  ELSIF p_action = 'reject' THEN
    IF c.status NOT IN ('pending','dispute') OR nullif(btrim(v_note),'') IS NULL THEN RAISE EXCEPTION 'ต้องเป็นรายการรออนุมัติ/ข้อพิพาท และระบุเหตุผล'; END IF;
    UPDATE inv_receiving_cases SET status='rejected',completed_at=now() WHERE id=c.id;
  ELSIF p_action = 'resubmit' THEN
    v_method := p_data->>'method';
    IF c.status <> 'dispute' OR v_method IS NULL OR v_method NOT IN ('refund','cancel_unpaid','vendor_refused') OR nullif(btrim(v_note),'') IS NULL THEN RAISE EXCEPTION 'เลือกวิธีจัดการและระบุผลการติดตาม'; END IF;
    UPDATE inv_receiving_cases SET method=v_method,status='pending',reason=v_note WHERE id=c.id;
    v_note := v_method || ': ' || v_note;
  ELSIF p_action = 'settle' THEN
    IF c.status NOT IN ('refund_pending','adjustment_pending') THEN RAISE EXCEPTION 'รายการไม่ได้รอบันทึกยอด'; END IF;
    SELECT * INTO f FROM inv_receiving_case_finance WHERE case_id=c.id FOR UPDATE;
    v_amount := (p_data->>'amount')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> round(v_amount,2) OR v_amount::text IN ('NaN','Infinity','-Infinity') OR v_amount > f.expected_amount-f.settled_amount THEN RAISE EXCEPTION 'จำนวนเงินต้องมากกว่า 0 และไม่เกินยอดคงเหลือ'; END IF;
    INSERT INTO inv_receiving_case_settlements(case_id,amount,reference,settled_on,actor_id)
      VALUES(c.id,v_amount,btrim(p_data->>'reference'),(p_data->>'settled_on')::date,auth.uid());
    UPDATE inv_receiving_case_finance SET settled_amount=settled_amount+v_amount WHERE case_id=c.id;
    IF f.settled_amount+v_amount = f.expected_amount THEN UPDATE inv_receiving_cases SET status='completed',completed_at=now() WHERE id=c.id; END IF;
    -- Never put amounts or banking references in the operational audit trail.
    v_note := '';
  ELSIF p_action = 'note' THEN
    IF nullif(btrim(v_note),'') IS NULL THEN RAISE EXCEPTION 'กรุณาระบุผลการติดตาม'; END IF;
  ELSE RAISE EXCEPTION 'คำสั่งไม่ถูกต้อง';
  END IF;
  UPDATE inv_receiving_cases SET updated_at=now() WHERE id=c.id;
  INSERT INTO inv_receiving_case_events(case_id,action,note,actor_id) VALUES(c.id,p_action,v_note,auth.uid());
END $$;
REVOKE ALL ON FUNCTION public.rpc_create_receiving_case(uuid,text,text,jsonb,uuid), public.rpc_receiving_case_action(uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_create_receiving_case(uuid,text,text,jsonb,uuid), public.rpc_receiving_case_action(uuid,text,jsonb) TO authenticated;

-- Retire the legacy bypass; all closures now require a recorded approval.
CREATE OR REPLACE FUNCTION public.rpc_resolve_po_shortage(p_po_id uuid,p_resolutions jsonb,p_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'กรุณาส่งคำขอผ่านเมนูติดตามยอดค้างรับ'; END $$;

-- Wrap the deployed receiving implementation without losing previous GR features.
ALTER FUNCTION public.rpc_receive_gr(uuid,jsonb,jsonb,uuid) RENAME TO rpc_receive_gr_before_cases;
REVOKE ALL ON FUNCTION public.rpc_receive_gr_before_cases(uuid,jsonb,jsonb,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.rpc_receive_gr(p_po_id uuid,p_items jsonb,p_shipping jsonb DEFAULT '{}',p_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r jsonb; i jsonb; poi inv_po_items%ROWTYPE;
BEGIN
  IF NOT public.erp_can_manage_receiving_cases() AND NOT EXISTS (SELECT 1 FROM us_users WHERE id=auth.uid() AND role IN ('picker','manager','auditor')) THEN RAISE EXCEPTION 'ไม่มีสิทธิ์รับสินค้า'; END IF;
  PERFORM 1 FROM inv_po WHERE id=p_po_id FOR UPDATE;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN RAISE EXCEPTION 'ไม่มีรายการรับ'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x GROUP BY x->>'product_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'สินค้าซ้ำในใบรับ'; END IF;
  FOR i IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO poi FROM inv_po_items WHERE po_id=p_po_id AND product_id=(i->>'product_id')::uuid FOR UPDATE;
    IF NOT FOUND OR (i->>'qty_received') IS NULL OR (i->>'qty_received')::numeric < 0 OR (i->>'qty_received')::numeric::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'รายการรับไม่ถูกต้อง'; END IF;
    IF coalesce(poi.resolution_qty,0)>0 AND (i->>'qty_received')::numeric > greatest(poi.qty-coalesce(poi.qty_received_total,0)-poi.resolution_qty,0) THEN RAISE EXCEPTION 'จำนวนรับเกินยอดคงเหลือหลังปิดยอดค้างรับ'; END IF;
  END LOOP;
  r := public.rpc_receive_gr_before_cases(p_po_id,p_items,p_shipping,auth.uid());
  UPDATE inv_po SET status='closed' WHERE id=p_po_id AND status='received' AND EXISTS (SELECT 1 FROM inv_po_items WHERE po_id=p_po_id AND resolution_qty>0);
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.rpc_receive_gr(uuid,jsonb,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_receive_gr(uuid,jsonb,jsonb,uuid) TO authenticated;

-- Private evidence: financial roles can read all; submitters can read their own.
-- No public URLs; signed URLs are issued only after storage RLS checks.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('receiving-case-evidence','receiving-case-evidence',false,10485760,ARRAY['image/jpeg','image/png','application/pdf']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY receiving_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id='receiving-case-evidence' AND public.erp_can_manage_receiving_cases()
  AND (storage.foldername(name))[2]=auth.uid()::text
  AND EXISTS (SELECT 1 FROM public.inv_receiving_cases WHERE id::text=(storage.foldername(name))[1])
);
CREATE POLICY receiving_evidence_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id='receiving-case-evidence' AND public.erp_can_manage_receiving_cases()
  AND (public.erp_can_view_cost() OR (storage.foldername(name))[2]=auth.uid()::text)
);

NOTIFY pgrst, 'reload schema';
COMMIT;
