BEGIN;

ALTER TABLE public.inv_audit_items ADD COLUMN sub_warehouse_snapshot jsonb;
CREATE INDEX IF NOT EXISTS idx_sub_moves_product_snapshot
  ON public.wh_sub_warehouse_stock_moves(product_id, created_at, sub_warehouse_id);

-- Separate note ledger; never added to main stock or the audit variance.
CREATE FUNCTION public.fn_audit_sub_warehouse_snapshot(p_product_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  WITH balances AS (
    SELECT m.sub_warehouse_id, sum(m.qty_delta) qty
    FROM public.wh_sub_warehouse_stock_moves m
    WHERE m.product_id=p_product_id AND m.created_at<=p_at
    GROUP BY m.sub_warehouse_id
  ), warehouse_ids AS (
    SELECT a.sub_warehouse_id FROM public.wh_sub_warehouse_products a
    WHERE a.product_id=p_product_id AND a.created_at<=p_at
    UNION SELECT b.sub_warehouse_id FROM balances b WHERE b.qty<>0
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'sub_warehouse_id',w.id,'name',w.name,'qty',COALESCE(b.qty,0)
  ) ORDER BY w.name,w.id),'[]'::jsonb)
  FROM warehouse_ids ids JOIN public.wh_sub_warehouses w ON w.id=ids.sub_warehouse_id
  LEFT JOIN balances b ON b.sub_warehouse_id=w.id
  WHERE w.created_at<=p_at AND (w.is_active OR COALESCE(b.qty,0)<>0);
$$;
REVOKE ALL ON FUNCTION public.fn_audit_sub_warehouse_snapshot(uuid,timestamptz) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_audit_sub_warehouse_snapshot(uuid,timestamptz) TO authenticated;

CREATE FUNCTION public.guard_audit_sub_warehouse_snapshot() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_at timestamptz;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT COALESCE(frozen_at,created_at) INTO v_at FROM inv_audits WHERE id=NEW.audit_id;
    NEW.sub_warehouse_snapshot:=fn_audit_sub_warehouse_snapshot(NEW.product_id,v_at);
  ELSIF NEW.sub_warehouse_snapshot IS DISTINCT FROM OLD.sub_warehouse_snapshot THEN
    RAISE EXCEPTION 'ไม่สามารถเปลี่ยนยอดคลังย่อยตั้งต้นของใบ Audit';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_audit_sub_warehouse_snapshot BEFORE INSERT OR UPDATE ON public.inv_audit_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_audit_sub_warehouse_snapshot();

-- Existing sheets have no saved snapshot. Reconstruct from their ledger cutoff
-- without updating counted/closed sheets or firing their count validation triggers.
-- Invoker rights preserve the caller's existing audit/table RLS, including store.
CREATE FUNCTION public.rpc_get_audit_legacy_sub_warehouse_snapshots(p_audit_id uuid)
RETURNS TABLE(item_id uuid,snapshot jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
  SELECT i.id,public.fn_audit_sub_warehouse_snapshot(i.product_id,COALESCE(a.frozen_at,a.created_at))
  FROM public.inv_audit_items i JOIN public.inv_audits a ON a.id=i.audit_id
  WHERE a.id=p_audit_id AND i.sub_warehouse_snapshot IS NULL
  ORDER BY i.id;
$$;
REVOKE ALL ON FUNCTION public.rpc_get_audit_legacy_sub_warehouse_snapshots(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_audit_legacy_sub_warehouse_snapshots(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
