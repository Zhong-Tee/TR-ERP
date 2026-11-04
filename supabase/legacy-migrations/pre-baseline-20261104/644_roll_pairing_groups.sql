-- New pairings only. No balance, movement or FIFO mutations here.
BEGIN;

ALTER TABLE public.roll_material_configs ADD COLUMN pairing_group_id uuid;
CREATE INDEX roll_material_configs_group_idx ON public.roll_material_configs(pairing_group_id);

CREATE FUNCTION public.rpc_create_roll_pairing_group(p_rm_id uuid, p_fg_ids uuid[], p_sheets numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_group uuid := gen_random_uuid(); v_fg uuid; v_config uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin','admin','store')) THEN
    RAISE EXCEPTION 'Not authorized to manage roll pairings';
  END IF;
  IF p_sheets IS NULL OR p_sheets <= 0 OR p_sheets::text IN ('NaN','Infinity','-Infinity') OR p_sheets <> round(p_sheets,2) OR p_sheets >= 10000000000 THEN
    RAISE EXCEPTION 'Invalid sheets per roll';
  END IF;
  IF coalesce(cardinality(p_fg_ids),0) = 0 OR cardinality(p_fg_ids) <> (SELECT count(DISTINCT id) FROM unnest(p_fg_ids) id) THEN
    RAISE EXCEPTION 'Select distinct FG products';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('roll_pairing_groups'));
  PERFORM 1 FROM public.pr_products WHERE id = p_rm_id AND product_type = 'RM' AND is_active IS TRUE FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active RM not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.roll_material_config_rms WHERE rm_product_id = p_rm_id)
     OR EXISTS (SELECT 1 FROM public.roll_material_configs WHERE rm_product_id = p_rm_id) THEN
    RAISE EXCEPTION 'RM already paired; existing pairings will not be replaced';
  END IF;
  FOR v_fg IN SELECT id FROM unnest(p_fg_ids) id ORDER BY id LOOP
    PERFORM 1 FROM public.pr_products WHERE id = v_fg AND product_type = 'FG' AND is_active IS TRUE FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active FG not found'; END IF;
    INSERT INTO public.roll_material_configs(fg_product_id,rm_product_id,sheets_per_roll,pairing_group_id)
      VALUES(v_fg,p_rm_id,p_sheets,v_group) RETURNING id INTO v_config;
    INSERT INTO public.roll_material_config_rms(config_id,rm_product_id) VALUES(v_config,p_rm_id);
  END LOOP;
END $$;

CREATE FUNCTION public.rpc_update_roll_group_sheets(p_config_id uuid, p_sheets numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_group uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin','admin','store')) THEN
    RAISE EXCEPTION 'Not authorized to manage roll pairings';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('roll_pairing_groups'));
  SELECT pairing_group_id INTO v_group FROM public.roll_material_configs WHERE id = p_config_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pairing not found'; END IF;
  IF (v_group IS NOT NULL AND p_sheets IS NULL) OR (p_sheets IS NOT NULL AND (p_sheets <= 0 OR p_sheets::text IN ('NaN','Infinity','-Infinity') OR p_sheets <> round(p_sheets,2) OR p_sheets >= 10000000000)) THEN
    RAISE EXCEPTION 'Invalid sheets per roll';
  END IF;
  UPDATE public.roll_material_configs SET sheets_per_roll = p_sheets, updated_at = now()
  WHERE id = p_config_id OR (v_group IS NOT NULL AND pairing_group_id = v_group);
END $$;

REVOKE ALL ON FUNCTION public.rpc_create_roll_pairing_group(uuid,uuid[],numeric), public.rpc_update_roll_group_sheets(uuid,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_roll_pairing_group(uuid,uuid[],numeric), public.rpc_update_roll_group_sheets(uuid,numeric) TO authenticated;

-- Preserve the deployed creator-role guards; replace only the ambiguity guard.
DO $migration$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  v_old := $old$HAVING count(DISTINCT m.config_id) > 1$old$;
  v_new := $new$HAVING count(DISTINCT m.config_id) > 1 AND NOT (
    count(DISTINCT (SELECT c.pairing_group_id FROM public.roll_material_configs c WHERE c.id = m.config_id)) = 1
    AND bool_and((SELECT c.pairing_group_id IS NOT NULL FROM public.roll_material_configs c WHERE c.id = m.config_id))
    AND count(DISTINCT (SELECT c.sheets_per_roll FROM public.roll_material_configs c WHERE c.id = m.config_id)) = 1
    AND bool_and((SELECT c.sheets_per_roll > 0 FROM public.roll_material_configs c WHERE c.id = m.config_id))
    AND bool_and((SELECT count(*) = 1 FROM public.roll_material_config_rms links WHERE links.config_id = m.config_id))
  )$new$;
  SELECT pg_get_functiondef('public.rpc_create_inventory_adjustment(text,text,text,jsonb)'::regprocedure) INTO v_definition;
  IF strpos(v_definition,v_old) = 0 THEN RAISE EXCEPTION 'Stocktake ambiguity guard not found; migration aborted'; END IF;
  EXECUTE replace(v_definition,v_old,v_new);
END $migration$;

COMMIT;
NOTIFY pgrst,'reload schema';
