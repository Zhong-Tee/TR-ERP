-- Machinery spare-parts stock, machine commissioning date and repair usage history.

BEGIN;

ALTER TABLE public.pr_machinery_machines
  ADD COLUMN IF NOT EXISTS commissioned_on DATE;

CREATE TABLE IF NOT EXISTS public.pr_machinery_machine_parts (
  machine_id UUID NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (machine_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_stock_balances (
  product_id UUID PRIMARY KEY REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (qty >= 0 AND qty = TRUNC(qty)),
  average_unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (average_unit_cost >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_no TEXT NOT NULL UNIQUE,
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,4) NOT NULL CHECK (qty > 0 AND qty = TRUNC(qty)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  note TEXT,
  requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  main_stock_movement_id UUID REFERENCES public.inv_stock_movements(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_incident_parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id UUID NOT NULL REFERENCES public.pr_machinery_incidents(id) ON DELETE RESTRICT,
  machine_id UUID NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE RESTRICT,
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('use','return')),
  qty NUMERIC(14,4) NOT NULL CHECK (qty > 0 AND qty = TRUNC(qty)),
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  return_of_id UUID REFERENCES public.pr_machinery_incident_parts(id) ON DELETE RESTRICT,
  note TEXT,
  performed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (event_type = 'use' AND return_of_id IS NULL)
    OR (event_type = 'return' AND return_of_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS public.pr_machinery_stock_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE RESTRICT,
  qty_delta NUMERIC(14,4) NOT NULL CHECK (qty_delta <> 0 AND qty_delta = TRUNC(qty_delta)),
  movement_type TEXT NOT NULL CHECK (movement_type IN ('transfer_in','part_use','part_return')),
  unit_cost NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  transfer_id UUID REFERENCES public.pr_machinery_stock_transfers(id) ON DELETE RESTRICT,
  incident_part_id UUID REFERENCES public.pr_machinery_incident_parts(id) ON DELETE RESTRICT,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_machinery_parts_product ON public.pr_machinery_machine_parts(product_id);
CREATE INDEX IF NOT EXISTS idx_machinery_transfers_status_time ON public.pr_machinery_stock_transfers(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_machinery_incident_parts_machine_time ON public.pr_machinery_incident_parts(machine_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_machinery_incident_parts_incident ON public.pr_machinery_incident_parts(incident_id);
CREATE INDEX IF NOT EXISTS idx_machinery_stock_moves_product_time ON public.pr_machinery_stock_moves(product_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.can_manage_machinery_spares_all()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND is_active = true AND role IN ('superadmin','admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_confirm_machinery_stock_transfer()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND is_active = true AND role IN ('superadmin','admin','store')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_use_machinery_spares()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND is_active = true AND role IN ('superadmin','admin','technician')
  );
$$;

CREATE OR REPLACE FUNCTION public.trg_guard_machinery_commissioned_on()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.commissioned_on IS NOT NULL
     AND NOT public.can_manage_machinery_spares_all() THEN
    RAISE EXCEPTION 'เฉพาะ superadmin และ admin เท่านั้นที่แก้วันที่เริ่มใช้งานเครื่องได้';
  ELSIF TG_OP = 'UPDATE'
     AND NEW.commissioned_on IS DISTINCT FROM OLD.commissioned_on
     AND NOT public.can_manage_machinery_spares_all() THEN
    RAISE EXCEPTION 'เฉพาะ superadmin และ admin เท่านั้นที่แก้วันที่เริ่มใช้งานเครื่องได้';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_machinery_commissioned_on ON public.pr_machinery_machines;
CREATE TRIGGER guard_machinery_commissioned_on
BEFORE INSERT OR UPDATE ON public.pr_machinery_machines
FOR EACH ROW EXECUTE FUNCTION public.trg_guard_machinery_commissioned_on();

ALTER TABLE public.pr_machinery_machine_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pr_machinery_stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pr_machinery_stock_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pr_machinery_incident_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pr_machinery_stock_moves ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_table TEXT;
  v_using TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'pr_machinery_machine_parts','pr_machinery_stock_balances',
    'pr_machinery_stock_transfers','pr_machinery_incident_parts','pr_machinery_stock_moves'
  ] LOOP
    v_using := CASE v_table
      WHEN 'pr_machinery_machine_parts' THEN
        '(public.can_manage_machinery_spares_all() OR public.can_use_machinery_spares())'
      WHEN 'pr_machinery_stock_balances' THEN
        '(public.can_manage_machinery_spares_all() OR public.can_confirm_machinery_stock_transfer() OR public.can_use_machinery_spares())'
      WHEN 'pr_machinery_stock_transfers' THEN
        '(public.can_manage_machinery_spares_all() OR public.can_confirm_machinery_stock_transfer())'
      WHEN 'pr_machinery_incident_parts' THEN
        '(public.can_manage_machinery_spares_all() OR public.can_use_machinery_spares())'
      ELSE
        'public.can_manage_machinery_spares_all()'
    END;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_read', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (%s)',
      v_table || '_read', v_table, v_using
    );
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', v_table);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_table);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_set_machinery_machine_parts(
  p_machine_id UUID,
  p_product_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_product_id UUID;
BEGIN
  IF NOT public.can_manage_machinery_spares_all() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์กำหนดอะไหล่ประจำเครื่อง';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pr_machinery_machines WHERE id = p_machine_id) THEN
    RAISE EXCEPTION 'ไม่พบเครื่องจักร';
  END IF;
  DELETE FROM public.pr_machinery_machine_parts WHERE machine_id = p_machine_id;
  FOREACH v_product_id IN ARRAY COALESCE(p_product_ids, ARRAY[]::UUID[])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.pr_machinery_purchase_products
      WHERE product_id = v_product_id AND enabled = true
    ) THEN
      RAISE EXCEPTION 'สินค้าที่เลือกยังไม่ได้เปิดใช้ในตั้งค่าสินค้า Machinery';
    END IF;
    INSERT INTO public.pr_machinery_machine_parts(machine_id, product_id, created_by)
    VALUES (p_machine_id, v_product_id, auth.uid()) ON CONFLICT DO NOTHING;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_next_machinery_transfer_no()
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_date TEXT := to_char(NOW() AT TIME ZONE 'Asia/Bangkok','YYYYMMDD'); v_seq INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('machinery-transfer-' || v_date));
  SELECT COALESCE(MAX((regexp_match(transfer_no, '([0-9]+)$'))[1]::INTEGER),0)+1 INTO v_seq
  FROM public.pr_machinery_stock_transfers WHERE transfer_no LIKE 'MTR-' || v_date || '-%';
  RETURN 'MTR-' || v_date || '-' || lpad(v_seq::TEXT,4,'0');
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_request_machinery_stock_transfer(
  p_product_id UUID,
  p_qty NUMERIC,
  p_note TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id UUID;
BEGIN
  IF NOT public.can_manage_machinery_spares_all() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์สร้างคำขอโอนอะไหล่';
  END IF;
  IF COALESCE(p_qty,0) <= 0 OR p_qty <> TRUNC(p_qty) THEN RAISE EXCEPTION 'จำนวนที่ขอโอนต้องเป็นจำนวนเต็มมากกว่า 0'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pr_machinery_purchase_products
    WHERE product_id = p_product_id AND enabled = true
  ) THEN RAISE EXCEPTION 'สินค้านี้ยังไม่ได้เปิดใช้ใน Machinery'; END IF;

  INSERT INTO public.pr_machinery_stock_transfers(
    transfer_no, product_id, qty, note, requested_by
  ) VALUES (
    public.fn_next_machinery_transfer_no(), p_product_id, p_qty,
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
  v_balance public.inv_stock_balances%ROWTYPE;
  v_movement_id UUID;
  v_unit_cost NUMERIC := 0;
BEGIN
  IF NOT public.can_confirm_machinery_stock_transfer() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันการโอนจากสต๊อกหลัก';
  END IF;
  SELECT * INTO v_transfer FROM public.pr_machinery_stock_transfers
  WHERE id = p_transfer_id FOR UPDATE;
  IF v_transfer.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการโอน'; END IF;
  IF v_transfer.status <> 'pending' THEN RAISE EXCEPTION 'รายการนี้ถูกดำเนินการแล้ว'; END IF;

  SELECT * INTO v_balance FROM public.inv_stock_balances
  WHERE product_id = v_transfer.product_id FOR UPDATE;
  IF v_balance.id IS NULL OR COALESCE(v_balance.on_hand,0) - COALESCE(v_balance.reserved,0) < v_transfer.qty THEN
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
  FROM public.inv_stock_movements WHERE id = v_movement_id;

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

  UPDATE public.pr_machinery_stock_transfers SET
    status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = NOW(),
    main_stock_movement_id = v_movement_id, updated_at = NOW()
  WHERE id = v_transfer.id;
  PERFORM public.fn_recalc_product_landed_cost(v_transfer.product_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_use_machinery_part(
  p_incident_id UUID,
  p_product_id UUID,
  p_qty NUMERIC,
  p_note TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_incident public.pr_machinery_incidents%ROWTYPE;
  v_balance public.pr_machinery_stock_balances%ROWTYPE;
  v_usage_id UUID;
BEGIN
  IF NOT public.can_use_machinery_spares() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกการใช้อะไหล่'; END IF;
  IF COALESCE(p_qty,0) <= 0 OR p_qty <> TRUNC(p_qty) THEN RAISE EXCEPTION 'จำนวนที่ใช้ต้องเป็นจำนวนเต็มมากกว่า 0'; END IF;
  SELECT * INTO v_incident FROM public.pr_machinery_incidents WHERE id = p_incident_id FOR UPDATE;
  IF v_incident.id IS NULL THEN RAISE EXCEPTION 'ไม่พบใบแจ้งซ่อม'; END IF;
  IF v_incident.status <> 'repairing' THEN RAISE EXCEPTION 'บันทึกอะไหล่ได้เมื่อสถานะเป็นกำลังซ่อมเท่านั้น'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pr_machinery_machine_parts
    WHERE machine_id = v_incident.machine_id AND product_id = p_product_id
  ) THEN RAISE EXCEPTION 'อะไหล่นี้ไม่ได้กำหนดไว้สำหรับเครื่องจักร'; END IF;

  SELECT * INTO v_balance FROM public.pr_machinery_stock_balances
  WHERE product_id = p_product_id FOR UPDATE;
  IF v_balance.product_id IS NULL OR v_balance.qty < p_qty THEN RAISE EXCEPTION 'สต๊อกอะไหล่ Machinery ไม่เพียงพอ'; END IF;
  UPDATE public.pr_machinery_stock_balances SET qty = qty - p_qty, updated_at = NOW()
  WHERE product_id = p_product_id;

  INSERT INTO public.pr_machinery_incident_parts(
    incident_id, machine_id, product_id, event_type, qty, unit_cost, note, performed_by
  ) VALUES (
    p_incident_id, v_incident.machine_id, p_product_id, 'use', p_qty,
    v_balance.average_unit_cost, NULLIF(BTRIM(p_note),''), auth.uid()
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

CREATE OR REPLACE FUNCTION public.rpc_return_machinery_part(
  p_usage_id UUID,
  p_qty NUMERIC,
  p_note TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_usage public.pr_machinery_incident_parts%ROWTYPE;
  v_returned NUMERIC := 0;
  v_current public.pr_machinery_stock_balances%ROWTYPE;
  v_return_id UUID;
BEGIN
  IF NOT public.can_use_machinery_spares() THEN RAISE EXCEPTION 'ไม่มีสิทธิ์คืนอะไหล่'; END IF;
  IF COALESCE(p_qty,0) <= 0 OR p_qty <> TRUNC(p_qty) THEN RAISE EXCEPTION 'จำนวนที่คืนต้องเป็นจำนวนเต็มมากกว่า 0'; END IF;
  SELECT * INTO v_usage FROM public.pr_machinery_incident_parts
  WHERE id = p_usage_id AND event_type = 'use' FOR UPDATE;
  IF v_usage.id IS NULL THEN RAISE EXCEPTION 'ไม่พบรายการใช้อะไหล่'; END IF;
  SELECT COALESCE(SUM(qty),0) INTO v_returned FROM public.pr_machinery_incident_parts
  WHERE return_of_id = v_usage.id AND event_type = 'return';
  IF v_returned + p_qty > v_usage.qty THEN RAISE EXCEPTION 'จำนวนคืนมากกว่าจำนวนที่ใช้'; END IF;

  SELECT * INTO v_current FROM public.pr_machinery_stock_balances
  WHERE product_id = v_usage.product_id FOR UPDATE;
  INSERT INTO public.pr_machinery_stock_balances(product_id, qty, average_unit_cost)
  VALUES (v_usage.product_id, p_qty, v_usage.unit_cost)
  ON CONFLICT (product_id) DO UPDATE SET
    average_unit_cost = CASE
      WHEN public.pr_machinery_stock_balances.qty + EXCLUDED.qty > 0 THEN
        ((public.pr_machinery_stock_balances.qty * public.pr_machinery_stock_balances.average_unit_cost)
          + (EXCLUDED.qty * EXCLUDED.average_unit_cost))
        / (public.pr_machinery_stock_balances.qty + EXCLUDED.qty)
      ELSE 0 END,
    qty = public.pr_machinery_stock_balances.qty + EXCLUDED.qty,
    updated_at = NOW();

  INSERT INTO public.pr_machinery_incident_parts(
    incident_id, machine_id, product_id, event_type, qty, unit_cost,
    return_of_id, note, performed_by
  ) VALUES (
    v_usage.incident_id, v_usage.machine_id, v_usage.product_id, 'return', p_qty,
    v_usage.unit_cost, v_usage.id, NULLIF(BTRIM(p_note),''), auth.uid()
  ) RETURNING id INTO v_return_id;
  INSERT INTO public.pr_machinery_stock_moves(
    product_id, qty_delta, movement_type, unit_cost, incident_part_id, note, created_by
  ) VALUES (
    v_usage.product_id, p_qty, 'part_return', v_usage.unit_cost,
    v_return_id, 'คืนอะไหล่', auth.uid()
  );
  RETURN v_return_id;
END;
$$;

REVOKE ALL ON FUNCTION public.can_manage_machinery_spares_all() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_confirm_machinery_stock_transfer() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_use_machinery_spares() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_machinery_commissioned_on() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_next_machinery_transfer_no() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_set_machinery_machine_parts(UUID,UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_request_machinery_stock_transfer(UUID,NUMERIC,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_confirm_machinery_stock_transfer(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_use_machinery_part(UUID,UUID,NUMERIC,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_return_machinery_part(UUID,NUMERIC,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_machinery_spares_all() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_confirm_machinery_stock_transfer() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_machinery_spares() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_machinery_machine_parts(UUID,UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_request_machinery_stock_transfer(UUID,NUMERIC,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_machinery_stock_transfer(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_use_machinery_part(UUID,UUID,NUMERIC,TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_return_machinery_part(UUID,NUMERIC,TEXT) TO authenticated;

INSERT INTO public.st_user_menus(role, menu_key, menu_name, has_access)
VALUES ('store', 'machinery', 'Machinery', TRUE)
ON CONFLICT (role, menu_key) DO UPDATE SET has_access = TRUE;

COMMIT;
