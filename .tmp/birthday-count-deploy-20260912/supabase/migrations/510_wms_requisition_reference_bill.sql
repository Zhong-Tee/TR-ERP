BEGIN;

ALTER TABLE public.wms_requisition_items
  ADD COLUMN IF NOT EXISTS reference_order_id uuid REFERENCES public.or_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference_bill_no text;

CREATE INDEX IF NOT EXISTS idx_wms_requisition_items_reference_order
  ON public.wms_requisition_items (reference_order_id)
  WHERE reference_order_id IS NOT NULL;

COMMENT ON COLUMN public.wms_requisition_items.reference_order_id
  IS 'บิลต้นทางที่อ้างอิงสำหรับรายการเบิกหัวข้อผลิตเสีย';
COMMENT ON COLUMN public.wms_requisition_items.reference_bill_no
  IS 'สำเนาเลขบิลอ้างอิง ณ เวลาที่สร้างใบเบิก เพื่อคงประวัติแม้บิลต้นทางถูกลบ';

COMMIT;
