-- Indexes for the date/status filters and paginated WMS dashboards.
CREATE INDEX IF NOT EXISTS idx_wms_requisitions_created_at
  ON public.wms_requisitions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_requisitions_status_created_at
  ON public.wms_requisitions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_requisition_items_topic_requisition
  ON public.wms_requisition_items (requisition_topic, requisition_id);

CREATE INDEX IF NOT EXISTS idx_wms_return_requisitions_created_at
  ON public.wms_return_requisitions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_return_requisitions_status_created_at
  ON public.wms_return_requisitions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wms_borrow_requisitions_created_at
  ON public.wms_borrow_requisitions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_borrow_requisitions_status_created_at
  ON public.wms_borrow_requisitions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wms_orders_created_at
  ON public.wms_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wms_orders_assigned_created_at
  ON public.wms_orders (assigned_to, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wms_notifications_status_created_at
  ON public.wms_notifications (status, created_at DESC);
