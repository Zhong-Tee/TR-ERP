-- Add optional per-item notes for requisition/borrow flows

ALTER TABLE wms_requisition_items
  ADD COLUMN IF NOT EXISTS item_note TEXT;

ALTER TABLE wms_borrow_requisition_items
  ADD COLUMN IF NOT EXISTS item_note TEXT;

