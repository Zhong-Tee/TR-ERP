-- Initialize only explicit multi-FG pairing groups. Ordinary legacy pairs stay unchanged.
BEGIN;
CREATE TABLE public.roll_pairing_stock_initializations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pairing_group_id uuid NOT NULL UNIQUE,
  rm_product_id uuid NOT NULL REFERENCES public.pr_products(id),
  rm_on_hand numeric NOT NULL,
  sheets_per_roll numeric NOT NULL,
  target_on_hand numeric NOT NULL,
  evidence jsonb NOT NULL,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.roll_pairing_stock_initializations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roll_pairing_stock_initializations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.roll_pairing_stock_initializations TO authenticated;
CREATE POLICY roll_pairing_initializations_read ON public.roll_pairing_stock_initializations
FOR SELECT TO authenticated USING(public.check_user_role(auth.uid(),ARRAY['superadmin','admin','store','account','manager']));

CREATE FUNCTION public.fn_initialize_multi_fg_pairing_stock(p_group uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_rm uuid; v_sheets numeric; v_rolls numeric; v_target numeric;
  v_id uuid; v_evidence jsonb; r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('roll_pairing_groups'));
  IF EXISTS(SELECT 1 FROM public.roll_pairing_stock_initializations WHERE pairing_group_id=p_group) THEN RETURN; END IF;
  IF (SELECT count(*) FROM public.roll_material_configs WHERE pairing_group_id=p_group)<2 THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.roll_material_configs c WHERE c.pairing_group_id=p_group
    AND (c.sheets_per_roll IS NULL OR c.sheets_per_roll<=0 OR
      (SELECT count(*) FROM public.roll_material_config_rms m WHERE m.config_id=c.id)<>1)) THEN
    RAISE EXCEPTION 'Invalid multi-FG pairing group';
  END IF;
  IF (SELECT count(DISTINCT m.rm_product_id) FROM public.roll_material_configs c
      JOIN public.roll_material_config_rms m ON m.config_id=c.id WHERE c.pairing_group_id=p_group)<>1
    OR (SELECT count(DISTINCT sheets_per_roll) FROM public.roll_material_configs WHERE pairing_group_id=p_group)<>1 THEN
    RAISE EXCEPTION 'Group must share one RM and one conversion rate';
  END IF;
  SELECT m.rm_product_id,c.sheets_per_roll INTO STRICT v_rm,v_sheets
    FROM public.roll_material_configs c JOIN public.roll_material_config_rms m ON m.config_id=c.id
    WHERE c.pairing_group_id=p_group LIMIT 1;
  PERFORM 1 FROM public.pr_products WHERE id=v_rm FOR UPDATE;
  SELECT coalesce(on_hand,0) INTO v_rolls FROM public.inv_stock_balances WHERE product_id=v_rm FOR UPDATE;
  v_rolls:=coalesce(v_rolls,0);
  v_target:=round(v_rolls*v_sheets,2);
  IF v_target<0 THEN RAISE EXCEPTION 'RM stock cannot be negative'; END IF;
  -- Lock FG balances in a stable order. Preserve reservations and safety stock.
  FOR r IN SELECT fg_product_id FROM public.roll_material_configs WHERE pairing_group_id=p_group ORDER BY fg_product_id LOOP
    INSERT INTO public.inv_stock_balances(product_id,on_hand,reserved,safety_stock)
      VALUES(r.fg_product_id,0,0,0) ON CONFLICT(product_id) DO NOTHING;
    PERFORM 1 FROM public.inv_stock_balances WHERE product_id=r.fg_product_id FOR UPDATE;
  END LOOP;
  SELECT jsonb_agg(jsonb_build_object('product_id',c.fg_product_id,'on_hand',b.on_hand,
    'reserved',b.reserved,'safety_stock',b.safety_stock) ORDER BY c.fg_product_id) INTO v_evidence
    FROM public.roll_material_configs c JOIN public.inv_stock_balances b ON b.product_id=c.fg_product_id
    WHERE c.pairing_group_id=p_group;
  INSERT INTO public.roll_pairing_stock_initializations(pairing_group_id,rm_product_id,rm_on_hand,sheets_per_roll,target_on_hand,evidence)
    VALUES(p_group,v_rm,v_rolls,v_sheets,v_target,v_evidence) RETURNING id INTO v_id;
  FOR r IN SELECT c.fg_product_id,coalesce(b.safety_stock,0) safety_stock
    FROM public.roll_material_configs c JOIN public.inv_stock_balances b ON b.product_id=c.fg_product_id
    WHERE c.pairing_group_id=p_group ORDER BY c.fg_product_id LOOP
    PERFORM public.fn_reconcile_stocktake_product(r.fg_product_id,v_target,r.safety_stock,v_id,
      'Initialize multi-FG pairing: '||v_rolls||' rolls x '||v_sheets||' sheets; group '||p_group);
  END LOOP;
  -- Give the generated movements/lots their real, auditable source document.
  UPDATE public.inv_stock_movements SET ref_type='roll_pairing_stock_initializations'
    WHERE ref_id=v_id AND ref_type='inv_adjustments';
  UPDATE public.inv_stock_lots SET ref_type='roll_pairing_stock_initializations'
    WHERE ref_id=v_id AND ref_type='stocktake_reconcile';
END $$;
REVOKE ALL ON FUNCTION public.fn_initialize_multi_fg_pairing_stock(uuid) FROM PUBLIC,anon,authenticated;

-- Keep the existing role and validation guards; initialize after all links exist.
DO $migration$
DECLARE v_definition text; v_updated text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_create_roll_pairing_group(uuid,uuid[],numeric)'::regprocedure) INTO v_definition;
  v_updated:=replace(v_definition,'  END LOOP;', '  END LOOP;
  PERFORM public.fn_initialize_multi_fg_pairing_stock(v_group);');
  IF v_updated=v_definition THEN RAISE EXCEPTION 'Pairing creator hook not found'; END IF;
  EXECUTE v_updated;
END $migration$;

-- Initialize existing explicit groups once, never reset stock on page refresh.
DO $backfill$
DECLARE r record;
BEGIN
  FOR r IN SELECT pairing_group_id FROM public.roll_material_configs
    WHERE pairing_group_id IS NOT NULL GROUP BY pairing_group_id HAVING count(*)>1
    ORDER BY pairing_group_id LOOP
    PERFORM public.fn_initialize_multi_fg_pairing_stock(r.pairing_group_id);
  END LOOP;
END $backfill$;
COMMIT;
NOTIFY pgrst,'reload schema';
