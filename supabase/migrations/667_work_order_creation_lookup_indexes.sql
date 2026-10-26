-- Work-order creation repeatedly looks up WMS rows by order item and stock
-- movements by WMS reference while synchronizing fulfillment/reservations.
-- Keep the names used by the production hotfix so existing indexes are reused.
-- Use regular index creation for compatibility with transactional migrations.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_wms_orders_source_order_item_id
  ON public.wms_orders (source_order_item_id);

CREATE INDEX IF NOT EXISTS idx_inv_stock_movements_ref_type_ref_id
  ON public.inv_stock_movements (ref_type, ref_id);

COMMIT;
