-- Allow Machinery request owners to edit a request until a PO is created.

BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_update_machinery_pr(
  p_pr_id uuid,
  p_items jsonb,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item jsonb;
  v_product_id uuid;
  v_qty numeric;
  v_last_price numeric(12,2);
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.inv_pr
    WHERE id = p_pr_id
      AND pr_type = 'machinery'
      AND requested_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'ไม่พบคำขอซื้อ หรือไม่มีสิทธิ์แก้ไขคำขอนี้';
  END IF;

  IF EXISTS (SELECT 1 FROM public.inv_po WHERE pr_id = p_pr_id) THEN
    RAISE EXCEPTION 'คำขอนี้สร้าง PO แล้ว ไม่สามารถแก้ไขได้';
  END IF;

  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'คำขอซื้อต้องมีสินค้าอย่างน้อย 1 รายการ';
  END IF;

  UPDATE public.inv_pr
  SET note = NULLIF(btrim(p_note), ''), updated_at = now()
  WHERE id = p_pr_id;

  DELETE FROM public.inv_pr_items WHERE pr_id = p_pr_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'จำนวนสินค้าต้องมากกว่า 0';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.pr_machinery_purchase_products
      WHERE product_id = v_product_id AND enabled
    ) THEN
      RAISE EXCEPTION 'สินค้านี้ไม่ได้เปิดให้ขอซื้อใน Machinery';
    END IF;

    SELECT last_price INTO v_last_price
    FROM public.v_product_last_price
    WHERE product_id = v_product_id;

    INSERT INTO public.inv_pr_items(
      pr_id, product_id, qty, unit, estimated_price, last_purchase_price, note
    ) VALUES (
      p_pr_id,
      v_product_id,
      v_qty,
      v_item->>'unit',
      v_last_price,
      v_last_price,
      NULLIF(btrim(v_item->>'note'), '')
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_machinery_pr(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_update_machinery_pr(uuid, jsonb, text) TO authenticated;

COMMIT;
