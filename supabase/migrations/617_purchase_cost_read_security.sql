-- Deploy together with the client read-routing change. No financial data is sent
-- to non-cost roles, including direct PostgREST and embedded relation reads.
BEGIN;
DO $$
DECLARE t text; cols text; safe_cols text; secret_cols text; allow_rows text; restrict_rows text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pr_products','inv_po','inv_po_items','inv_pr_items'] LOOP
    SELECT string_agg(CASE WHEN a.attname IN ('unit_cost','landed_cost','unit_price','subtotal','total_amount','grand_total','estimated_price','last_purchase_price')
      THEN format('CASE WHEN public.erp_can_view_cost() THEN %I ELSE NULL END AS %I',a.attname,a.attname)
      ELSE quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
      string_agg(quote_ident(a.attname),', ' ORDER BY a.attnum) FILTER (WHERE a.attname NOT IN ('unit_cost','landed_cost','unit_price','subtotal','total_amount','grand_total','estimated_price','last_purchase_price')),
      string_agg(quote_ident(a.attname),', ' ORDER BY a.attnum) FILTER (WHERE a.attname IN ('unit_cost','landed_cost','unit_price','subtotal','total_amount','grand_total','estimated_price','last_purchase_price'))
      INTO cols,safe_cols,secret_cols
    FROM pg_attribute a WHERE a.attrelid=format('public.%I',t)::regclass AND a.attnum>0 AND NOT a.attisdropped;
    -- Preserve the existing authenticated SELECT policy predicates in the owner
    -- view. When changing those policies, regenerate these four views as well.
    SELECT string_agg('('||coalesce(qual,'true')||')',' OR ') FILTER (WHERE permissive='PERMISSIVE'),
           string_agg('('||coalesce(qual,'true')||')',' AND ') FILTER (WHERE permissive='RESTRICTIVE')
      INTO allow_rows,restrict_rows FROM pg_policies WHERE schemaname='public' AND tablename=t
      AND cmd IN ('SELECT','ALL') AND roles && ARRAY['public','authenticated']::name[];
    EXECUTE format('CREATE OR REPLACE VIEW public.%I WITH (security_barrier=true) AS SELECT %s FROM public.%I WHERE auth.role() = ''authenticated'' AND (%s) AND (%s)',
      'v_cost_safe_'||t,cols,t,coalesce(allow_rows,'false'),coalesce(restrict_rows,'true'));
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated','v_cost_safe_'||t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated','v_cost_safe_'||t);
    -- Table-level SELECT overrides column revocations, so remove both first.
    EXECUTE format('REVOKE SELECT ON public.%I FROM PUBLIC,anon,authenticated',t);
    IF secret_cols IS NOT NULL THEN EXECUTE format('REVOKE SELECT (%s) ON public.%I FROM PUBLIC,anon,authenticated',secret_cols,t); END IF;
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated',safe_cols,t);
  END LOOP;
END $$;

-- Preserve the deployed converter, but never leak totals through RPC responses.
ALTER FUNCTION public.rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid) RENAME TO rpc_convert_pr_to_po_before_cost_guard;
REVOKE ALL ON FUNCTION public.rpc_convert_pr_to_po_before_cost_guard(uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.rpc_convert_pr_to_po(p_pr_id uuid,p_supplier_id uuid DEFAULT NULL,p_supplier_name text DEFAULT NULL,p_prices jsonb DEFAULT '[]',p_note text DEFAULT NULL,p_user_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM 1 FROM inv_pr WHERE id=p_pr_id FOR UPDATE;
  result := public.rpc_convert_pr_to_po_before_cost_guard(p_pr_id,p_supplier_id,p_supplier_name,
    CASE WHEN public.erp_can_view_cost() THEN p_prices ELSE '[]'::jsonb END,p_note,auth.uid());
  RETURN CASE WHEN public.erp_can_view_cost() THEN result ELSE result-'total_amount'-'grand_total' END;
END $$;
REVOKE ALL ON FUNCTION public.rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_convert_pr_to_po(uuid,uuid,text,jsonb,text,uuid) TO authenticated;

-- Monetary PO editing is reserved for cost roles. Nonfinancial edits retain
-- their existing separately guarded RPC and never return a monetary total.
DO $$ DECLARE signature text; definition text; BEGIN
  FOREACH signature IN ARRAY ARRAY['public.rpc_update_po(uuid,text,date,jsonb)','public.rpc_update_po_nonfinancial(uuid,text,date,jsonb)'] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    definition := regexp_replace(definition,'BEGIN',E'BEGIN\n  IF NOT public.erp_can_view_cost() THEN RAISE EXCEPTION ''ไม่มีสิทธิ์แก้ไขข้อมูลต้นทุน''; END IF;',1,1);
    EXECUTE definition;
  END LOOP;
END $$;

-- Do not allow direct REST updates to bypass approval/audit. SECURITY DEFINER
-- workflow functions run as their owner; callers cannot impersonate that role.
CREATE FUNCTION public.guard_receiving_closure_write() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_TABLE_NAME='inv_po_items' THEN
      IF TG_OP='INSERT' THEN
        IF coalesce(NEW.resolution_qty,0)<>0 OR NEW.resolution_type IS NOT NULL OR NEW.resolved_by IS NOT NULL
          OR NEW.resolved_at IS NOT NULL OR NEW.resolution_note IS NOT NULL THEN RAISE EXCEPTION 'ต้องปิดยอดผ่านการอนุมัติ'; END IF;
      ELSIF NEW.resolution_qty IS DISTINCT FROM OLD.resolution_qty OR NEW.resolution_type IS DISTINCT FROM OLD.resolution_type
        OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
        OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note THEN RAISE EXCEPTION 'ต้องปิดยอดผ่านการอนุมัติ'; END IF;
    ELSIF NEW.status='closed' AND OLD.status IS DISTINCT FROM 'closed' THEN RAISE EXCEPTION 'ต้องปิดยอดผ่านการอนุมัติ';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiving_closure_item_guard BEFORE INSERT OR UPDATE ON public.inv_po_items FOR EACH ROW EXECUTE FUNCTION public.guard_receiving_closure_write();
CREATE TRIGGER receiving_closure_po_guard BEFORE INSERT OR UPDATE ON public.inv_po FOR EACH ROW EXECUTE FUNCTION public.guard_receiving_closure_write();
NOTIFY pgrst,'reload schema';
COMMIT;
