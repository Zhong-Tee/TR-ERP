-- Production/packing start processing; Store confirms actual receipt and closes the job.
-- Admin/superadmin retain both permissions. Inventory and costing logic is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_pp_production_status_roles()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE v_role text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;
  SELECT role INTO v_role FROM public.us_users
  WHERE id = auth.uid() AND is_active IS TRUE;

  IF NEW.status = 'pending' AND (v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ส่งใบแปรรูปเพื่ออนุมัติ';
  ELSIF NEW.status IN ('approved', 'rejected') AND (v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์อนุมัติหรือปฏิเสธใบแปรรูป';
  ELSIF NEW.status = 'processing' AND (v_role IS NULL OR v_role NOT IN ('production', 'packing_staff', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เริ่มแปรรูป';
  ELSIF NEW.status = 'completed' AND (v_role IS NULL OR v_role NOT IN ('store', 'admin', 'superadmin')) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันรับเข้าผลผลิต';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_complete_production_order_actual(p_order_id uuid, p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid uuid := auth.uid(); v_role text; v_status text; v_item record; v_recipe uuid;
  v_input jsonb; v_m jsonb; v_b jsonb; v_r record; v_product record;
  v_actual numeric; v_used numeric; v_return numeric; v_waste numeric; v_short numeric;
  v_qty numeric; v_cost numeric; v_material_cost numeric; v_shortage_cost numeric;
  v_byproduct_cost numeric; v_total numeric; v_unit numeric; v_balance numeric;
  v_max numeric; v_move uuid; v_report jsonb; v_materials jsonb; v_byproducts jsonb;
  v_any_short boolean := false;
BEGIN
  SELECT role INTO v_role FROM us_users WHERE id = v_uid AND is_active IS TRUE;
  IF v_role IS NULL OR v_role NOT IN ('store','admin','superadmin') THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ยืนยันรับเข้าผลผลิต';
  END IF;
  SELECT status INTO v_status FROM pp_production_orders WHERE id = p_order_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'processing' THEN RAISE EXCEPTION 'ใบแปรรูปไม่ได้อยู่ระหว่างการผลิต หรือปิดงานแล้ว'; END IF;
  -- Serialize edits to the item rows while validating and applying the receipt.
  PERFORM 1 FROM pp_production_order_items WHERE order_id = p_order_id ORDER BY id FOR UPDATE;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'กรุณาระบุผลผลิตจริง'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <> (SELECT count(*) FROM pp_production_order_items WHERE order_id = p_order_id)
     OR (SELECT count(DISTINCT x->>'item_id') FROM jsonb_array_elements(p_items) x) <> jsonb_array_length(p_items)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) x WHERE NOT EXISTS
       (SELECT 1 FROM pp_production_order_items oi WHERE oi.order_id = p_order_id AND oi.id::text = x->>'item_id')) THEN
    RAISE EXCEPTION 'รายการผลผลิตไม่ตรงกับใบแปรรูป';
  END IF;

  -- Lock recipes and their lines for a consistent completion snapshot.
  PERFORM 1 FROM pp_recipes WHERE product_id IN (SELECT product_id FROM pp_production_order_items WHERE order_id = p_order_id) ORDER BY id FOR SHARE;
  PERFORM 1 FROM pp_recipe_includes WHERE recipe_id IN (SELECT r.id FROM pp_recipes r JOIN pp_production_order_items oi ON oi.product_id=r.product_id WHERE oi.order_id=p_order_id) ORDER BY id FOR SHARE;
  PERFORM 1 FROM pp_recipe_removes WHERE recipe_id IN (SELECT r.id FROM pp_recipes r JOIN pp_production_order_items oi ON oi.product_id=r.product_id WHERE oi.order_id=p_order_id) ORDER BY id FOR SHARE;
  -- Create and lock balance rows in a stable order, including shared materials.
  FOR v_product IN
    SELECT product_id FROM pp_production_order_items WHERE order_id=p_order_id
    UNION SELECT i.product_id FROM pp_recipe_includes i JOIN pp_recipes r ON r.id=i.recipe_id JOIN pp_production_order_items oi ON oi.product_id=r.product_id WHERE oi.order_id=p_order_id
    UNION SELECT i.product_id FROM pp_recipe_removes i JOIN pp_recipes r ON r.id=i.recipe_id JOIN pp_production_order_items oi ON oi.product_id=r.product_id WHERE oi.order_id=p_order_id
    ORDER BY product_id
  LOOP
    INSERT INTO inv_stock_balances(product_id,on_hand,reserved,safety_stock) VALUES(v_product.product_id,0,0,0) ON CONFLICT(product_id) DO NOTHING;
    PERFORM 1 FROM inv_stock_balances WHERE product_id=v_product.product_id FOR UPDATE;
  END LOOP;

  FOR v_item IN SELECT oi.*,p.product_code,p.product_name FROM pp_production_order_items oi JOIN pr_products p ON p.id=oi.product_id WHERE order_id=p_order_id ORDER BY oi.id LOOP
    SELECT x INTO v_input FROM jsonb_array_elements(p_items) x WHERE x->>'item_id'=v_item.id::text;
    IF COALESCE(v_input->>'actual_qty','') !~ '^\d+(\.\d{1,2})?$' THEN RAISE EXCEPTION 'จำนวนผลิตจริงไม่ถูกต้อง'; END IF;
    v_actual := (v_input->>'actual_qty')::numeric;
    IF v_actual > v_item.qty THEN RAISE EXCEPTION 'จำนวนผลิตจริงเกินจำนวนที่ขอ'; END IF;
    IF v_actual < v_item.qty THEN
      v_any_short := true;
      IF COALESCE(v_input->>'reason_code','') NOT IN ('วัตถุดิบในห่อไม่ครบ','วัตถุดิบไม่เพียงพอ','ชำรุดระหว่างผลิต','สูญเสียระหว่างผลิต','อื่น ๆ') OR btrim(COALESCE(v_input->>'reason',''))='' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลและรายละเอียดที่ผลิตขาด'; END IF;
    END IF;
    SELECT id,max_stock INTO v_recipe,v_max FROM pp_recipes WHERE product_id=v_item.product_id;
    IF v_recipe IS NULL THEN RAISE EXCEPTION 'ไม่พบสูตรแปรรูป'; END IF;
    IF jsonb_typeof(v_input->'materials') IS DISTINCT FROM 'array' OR jsonb_typeof(v_input->'byproducts') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'กรุณาระบุรายการวัตถุดิบและสินค้าที่แยกคืน'; END IF;
    IF jsonb_array_length(v_input->'materials') <> (SELECT count(DISTINCT product_id) FROM pp_recipe_includes WHERE recipe_id=v_recipe)
       OR (SELECT count(DISTINCT x->>'product_id') FROM jsonb_array_elements(v_input->'materials') x) <> jsonb_array_length(v_input->'materials')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_input->'materials') x WHERE NOT EXISTS (SELECT 1 FROM pp_recipe_includes WHERE recipe_id=v_recipe AND product_id::text=x->>'product_id')) THEN RAISE EXCEPTION 'รายการวัตถุดิบไม่ตรงกับสูตร กรุณาเปิดบันทึกผลผลิตใหม่'; END IF;
    IF jsonb_array_length(v_input->'byproducts') <> (SELECT count(DISTINCT product_id) FROM pp_recipe_removes WHERE recipe_id=v_recipe)
       OR (SELECT count(DISTINCT x->>'product_id') FROM jsonb_array_elements(v_input->'byproducts') x) <> jsonb_array_length(v_input->'byproducts')
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_input->'byproducts') x WHERE NOT EXISTS (SELECT 1 FROM pp_recipe_removes WHERE recipe_id=v_recipe AND product_id::text=x->>'product_id')) THEN RAISE EXCEPTION 'รายการสินค้าที่แยกคืนไม่ตรงกับสูตร'; END IF;
    v_material_cost:=0; v_shortage_cost:=0; v_byproduct_cost:=0; v_materials:='[]'; v_byproducts:='[]';
    FOR v_r IN SELECT i.product_id,round(sum(i.qty)*v_item.qty,2) planned_qty,p.product_code,p.product_name FROM pp_recipe_includes i JOIN pr_products p ON p.id=i.product_id WHERE recipe_id=v_recipe GROUP BY i.product_id,p.product_code,p.product_name ORDER BY i.product_id LOOP
      SELECT x INTO v_m FROM jsonb_array_elements(v_input->'materials') x WHERE x->>'product_id'=v_r.product_id::text;
      IF EXISTS (SELECT 1 FROM unnest(ARRAY['used_qty','returned_qty','waste_qty','shortage_qty']) k WHERE COALESCE(v_m->>k,'') !~ '^\d+(\.\d{1,2})?$') THEN RAISE EXCEPTION 'จำนวนวัตถุดิบไม่ถูกต้อง'; END IF;
      v_used:=(v_m->>'used_qty')::numeric; v_return:=(v_m->>'returned_qty')::numeric; v_waste:=(v_m->>'waste_qty')::numeric; v_short:=(v_m->>'shortage_qty')::numeric;
      IF v_used+v_return+v_waste+v_short <> v_r.planned_qty THEN RAISE EXCEPTION 'ยอดใช้ คืน สูญเสีย และขาดจากห่อ ของ % ไม่ตรงกับยอดตามเอกสาร %',v_r.product_code,v_r.planned_qty; END IF;
      IF (v_used<>v_r.planned_qty OR v_waste>0 OR v_short>0) AND btrim(COALESCE(v_m->>'reason',''))='' THEN RAISE EXCEPTION 'กรุณาระบุเหตุผลส่วนต่างวัตถุดิบ %',v_r.product_code; END IF;
      v_qty:=v_used+v_waste+v_short;
      SELECT on_hand INTO v_balance FROM inv_stock_balances WHERE product_id=v_r.product_id;
      IF v_balance < v_qty THEN RAISE EXCEPTION 'สต็อกวัตถุดิบ % ไม่เพียงพอ ต้องการ % คงเหลือ %',v_r.product_code,v_qty,v_balance; END IF;
      -- Nothing was deducted at start: unused returns remain in stock, no extra receipt.
      v_cost:=0;
      IF v_used+v_waste>0 THEN
        INSERT INTO inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note,created_by) VALUES(v_r.product_id,'pp_consume',-(v_used+v_waste),'pp_production_orders',p_order_id,'ใช้ผลิตจริงและสูญเสีย: '||COALESCE(v_m->>'reason',''),v_uid) RETURNING id INTO v_move;
        v_cost:=fn_consume_stock_fifo(v_r.product_id,v_used+v_waste,v_move);
        v_material_cost:=v_material_cost+v_cost;
      END IF;
      v_m:=jsonb_build_object('product_id',v_r.product_id,'product_code',v_r.product_code,'product_name',v_r.product_name,'planned_qty',v_r.planned_qty,'used_qty',v_used,'returned_qty',v_return,'waste_qty',v_waste,'shortage_qty',v_short,'reason',COALESCE(v_m->>'reason',''),'material_cost',v_cost);
      v_cost:=0;
      IF v_short>0 THEN
        INSERT INTO inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note,created_by) VALUES(v_r.product_id,'pp_shortage',-v_short,'pp_production_orders',p_order_id,'ขาดจากห่อ: '||(v_m->>'reason'),v_uid) RETURNING id INTO v_move;
        v_cost:=fn_consume_stock_fifo(v_r.product_id,v_short,v_move);
        v_shortage_cost:=v_shortage_cost+v_cost;
      END IF;
      UPDATE inv_stock_balances SET on_hand=on_hand-v_qty,updated_at=now() WHERE product_id=v_r.product_id;
      PERFORM fn_recalc_product_landed_cost(v_r.product_id);
      v_materials:=v_materials||jsonb_build_array(v_m||jsonb_build_object('shortage_cost',v_cost));
    END LOOP;
    FOR v_r IN SELECT i.product_id,round(sum(i.qty)*v_item.qty,2) planned_qty,sum(i.qty*i.unit_cost)/NULLIF(sum(i.qty),0) unit_cost,p.product_code,p.product_name FROM pp_recipe_removes i JOIN pr_products p ON p.id=i.product_id WHERE recipe_id=v_recipe GROUP BY i.product_id,p.product_code,p.product_name ORDER BY i.product_id LOOP
      SELECT x INTO v_b FROM jsonb_array_elements(v_input->'byproducts') x WHERE x->>'product_id'=v_r.product_id::text;
      IF COALESCE(v_b->>'qty','') !~ '^\d+(\.\d{1,2})?$' THEN RAISE EXCEPTION 'จำนวนสินค้าที่แยกคืนไม่ถูกต้อง'; END IF;
      v_qty:=(v_b->>'qty')::numeric; v_cost:=v_qty*COALESCE(v_r.unit_cost,0);
      IF v_r.unit_cost<0 THEN RAISE EXCEPTION 'ต้นทุนสินค้าแยกคืนต้องไม่ติดลบ'; END IF;
      v_byproduct_cost:=v_byproduct_cost+v_cost;
      IF v_qty>0 THEN
        UPDATE inv_stock_balances SET on_hand=on_hand+v_qty,updated_at=now() WHERE product_id=v_r.product_id;
        INSERT INTO inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note,created_by,unit_cost,total_cost) VALUES(v_r.product_id,'pp_remove',v_qty,'pp_production_orders',p_order_id,'รับสินค้าแยกคืนตามจริง',v_uid,v_r.unit_cost,v_cost);
        INSERT INTO inv_stock_lots(product_id,qty_initial,qty_remaining,unit_cost,ref_type,ref_id) VALUES(v_r.product_id,v_qty,v_qty,v_r.unit_cost,'pp_production_orders',p_order_id);
        PERFORM fn_recalc_product_landed_cost(v_r.product_id);
      END IF;
      v_byproducts:=v_byproducts||jsonb_build_array(jsonb_build_object('product_id',v_r.product_id,'product_code',v_r.product_code,'product_name',v_r.product_name,'planned_qty',v_r.planned_qty,'qty',v_qty,'unit_cost',v_r.unit_cost,'total_cost',v_cost));
    END LOOP;
    v_total:=v_material_cost-v_byproduct_cost;
    IF v_total<0 THEN RAISE EXCEPTION 'มูลค่าสินค้าแยกคืนเกินต้นทุนวัตถุดิบที่ใช้จริง'; END IF;
    v_unit:=CASE WHEN v_actual>0 THEN round(v_total/v_actual,4) ELSE 0 END;
    SELECT on_hand INTO v_balance FROM inv_stock_balances WHERE product_id=v_item.product_id;
    IF v_actual>0 AND v_max IS NOT NULL AND v_balance+v_actual>v_max THEN RAISE EXCEPTION 'จำนวนรับเข้าจริงเกิน Max ที่กำหนด'; END IF;
    IF v_actual>0 THEN
      UPDATE inv_stock_balances SET on_hand=on_hand+v_actual,updated_at=now() WHERE product_id=v_item.product_id;
      INSERT INTO inv_stock_movements(product_id,movement_type,qty,ref_type,ref_id,note,created_by,unit_cost,total_cost) VALUES(v_item.product_id,'pp_produce',v_actual,'pp_production_orders',p_order_id,'รับผลผลิตจริง ปิดงานไม่ค้างยอดขาด',v_uid,v_unit,v_total);
      INSERT INTO inv_stock_lots(product_id,qty_initial,qty_remaining,unit_cost,ref_type,ref_id) VALUES(v_item.product_id,v_actual,v_actual,v_unit,'pp_production_orders',p_order_id);
      PERFORM fn_recalc_product_landed_cost(v_item.product_id);
    END IF;
    v_report:=jsonb_build_object('item_id',v_item.id,'product_code',v_item.product_code,'product_name',v_item.product_name,'planned_qty',v_item.qty,'actual_qty',v_actual,'reason_code',COALESCE(v_input->>'reason_code',''),'reason',COALESCE(v_input->>'reason',''),'materials',v_materials,'byproducts',v_byproducts,'material_cost',v_material_cost,'shortage_cost',v_shortage_cost,'byproduct_cost',v_byproduct_cost,'production_loss_cost',CASE WHEN v_actual=0 THEN v_total ELSE 0 END,'unit_cost',v_unit,'total_cost',CASE WHEN v_actual>0 THEN v_total ELSE 0 END);
    UPDATE pp_production_order_items SET actual_qty=v_actual,completion_report=v_report,unit_cost=v_unit,total_cost=CASE WHEN v_actual>0 THEN v_total ELSE 0 END WHERE id=v_item.id;
  END LOOP;
  UPDATE pp_production_orders SET status='completed',completion_short=v_any_short,completed_by=v_uid,completed_at=now() WHERE id=p_order_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_complete_production_order_actual(uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_complete_production_order_actual(uuid,jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
