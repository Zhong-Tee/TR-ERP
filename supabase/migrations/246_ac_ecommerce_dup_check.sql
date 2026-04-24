-- ตรวจเลขคำสั่งซื้อที่มีอยู่แล้วในช่องทางเดียวกัน (ป้องกันอัปโหลดซ้ำ)
BEGIN;

CREATE OR REPLACE FUNCTION public.ac_ecommerce_existing_order_nos(
  p_channel_id uuid,
  p_order_nos text[]
)
RETURNS TABLE(order_no text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT trim(both FROM sl.order_no)::text AS order_no
  FROM public.ac_ecommerce_sale_lines sl
  INNER JOIN public.ac_ecommerce_import_batches b ON b.id = sl.batch_id
  WHERE b.channel_id = p_channel_id
    AND sl.order_no IS NOT NULL
    AND trim(both FROM sl.order_no) <> ''
    AND trim(both FROM sl.order_no) IN (
      SELECT trim(both FROM x)
      FROM unnest(p_order_nos) AS u(x)
      WHERE trim(both FROM x) <> ''
    );
$$;

COMMENT ON FUNCTION public.ac_ecommerce_existing_order_nos(uuid, text[]) IS
  'คืนเลขคำสั่งซื้อที่มีใน ac_ecommerce_sale_lines แล้วสำหรับ channel_id ที่ระบุ และอยู่ในรายการ p_order_nos (เปรียบเทียบแบบ trim)';

GRANT EXECUTE ON FUNCTION public.ac_ecommerce_existing_order_nos(uuid, text[]) TO authenticated;

COMMIT;
