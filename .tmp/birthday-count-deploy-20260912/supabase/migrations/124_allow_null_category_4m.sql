-- Allow NULL for category_4m on all topic tables (the "-" / "ไม่มี" option)

-- wms_requisition_topics: drop old check, set default NULL, add new check allowing NULL
ALTER TABLE wms_requisition_topics ALTER COLUMN category_4m SET DEFAULT NULL;
ALTER TABLE wms_requisition_topics DROP CONSTRAINT IF EXISTS wms_requisition_topics_category_4m_check;
ALTER TABLE wms_requisition_topics ADD CONSTRAINT wms_requisition_topics_category_4m_check
  CHECK (category_4m IS NULL OR category_4m IN ('Man', 'Machine', 'Material', 'Method'));

-- wms_return_topics: drop old check, set default NULL, add new check allowing NULL
ALTER TABLE wms_return_topics ALTER COLUMN category_4m SET DEFAULT NULL;
ALTER TABLE wms_return_topics DROP CONSTRAINT IF EXISTS wms_return_topics_category_4m_check;
ALTER TABLE wms_return_topics ADD CONSTRAINT wms_return_topics_category_4m_check
  CHECK (category_4m IS NULL OR category_4m IN ('Man', 'Machine', 'Material', 'Method'));

-- wms_borrow_topics: drop old check, set default NULL, add new check allowing NULL
ALTER TABLE wms_borrow_topics ALTER COLUMN category_4m SET DEFAULT NULL;
ALTER TABLE wms_borrow_topics DROP CONSTRAINT IF EXISTS wms_borrow_topics_category_4m_check;
ALTER TABLE wms_borrow_topics ADD CONSTRAINT wms_borrow_topics_category_4m_check
  CHECK (category_4m IS NULL OR category_4m IN ('Man', 'Machine', 'Material', 'Method'));
