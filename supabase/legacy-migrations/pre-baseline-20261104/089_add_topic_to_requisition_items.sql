-- Add requisition_topic column to wms_requisition_items (per-item topic)
ALTER TABLE wms_requisition_items
  ADD COLUMN IF NOT EXISTS requisition_topic TEXT;
