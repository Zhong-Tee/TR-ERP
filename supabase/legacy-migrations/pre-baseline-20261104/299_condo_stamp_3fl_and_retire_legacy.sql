-- Retire legacy condo stamp products without deleting history, and normalize 3FL detail rows.

UPDATE pr_products
SET is_active = false,
    updated_at = now()
WHERE trim(product_name) IN ('ตรายางคอนโด TWP ชมพู', 'ตรายางคอนโด TWB ฟ้า')
  AND is_active = true;

UPDATE or_order_items oi
SET is_detail_row = true
FROM pr_products p
WHERE p.id = oi.product_id
  AND upper(trim(coalesce(p.product_category, ''))) = 'CONDO STAMP 3FL'
  AND coalesce(oi.product_type, 'ชั้น1') <> 'ชั้น1';

UPDATE or_order_items child
SET parent_item_id = (
  SELECT parent.id
  FROM or_order_items parent
  WHERE parent.order_id = child.order_id
    AND parent.product_id = child.product_id
    AND coalesce(parent.product_type, 'ชั้น1') = 'ชั้น1'
    AND parent.created_at <= child.created_at
  ORDER BY parent.created_at DESC, parent.id DESC
  LIMIT 1
)
WHERE child.is_detail_row = true
  AND child.parent_item_id IS NULL
  AND EXISTS (
    SELECT 1 FROM pr_products p
    WHERE p.id = child.product_id
      AND upper(trim(coalesce(p.product_category, ''))) = 'CONDO STAMP 3FL'
  );
