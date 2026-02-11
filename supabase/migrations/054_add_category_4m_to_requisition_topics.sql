-- Add category_4m column to wms_requisition_topics
ALTER TABLE wms_requisition_topics
  ADD COLUMN IF NOT EXISTS category_4m TEXT DEFAULT 'Man'
  CHECK (category_4m IN ('Man', 'Machine', 'Material', 'Method'));
