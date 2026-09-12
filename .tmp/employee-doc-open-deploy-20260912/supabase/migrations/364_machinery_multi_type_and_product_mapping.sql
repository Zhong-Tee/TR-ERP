-- Machinery: multiple machine types and product mapping for production totals.

ALTER TABLE public.pr_machinery_machines
  ADD COLUMN IF NOT EXISTS machine_type text NOT NULL DEFAULT 'ทั่วไป',
  ADD COLUMN IF NOT EXISTS capacity_unit text NOT NULL DEFAULT 'หน่วย',
  ADD COLUMN IF NOT EXISTS product_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE INDEX IF NOT EXISTS idx_pr_machinery_machines_type
  ON public.pr_machinery_machines(machine_type);

CREATE INDEX IF NOT EXISTS idx_pr_machinery_machines_product_ids
  ON public.pr_machinery_machines USING gin(product_ids);

COMMENT ON COLUMN public.pr_machinery_machines.machine_type IS 'ประเภท/กลุ่มเครื่องจักร เช่น เครื่องพิมพ์ เครื่องตัด เครื่องเคลือบ';
COMMENT ON COLUMN public.pr_machinery_machines.capacity_unit IS 'หน่วยกำลังผลิต เช่น ชิ้น เมตร แผ่น กก.';
COMMENT ON COLUMN public.pr_machinery_machines.product_ids IS 'สินค้าที่เครื่องนี้รับผิดชอบ ใช้รวมยอดจากใบสั่งงานที่สร้างวันนี้';
