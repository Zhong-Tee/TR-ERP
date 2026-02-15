-- ตาราง qc_skip_logs: บันทึกรายการที่ข้ามการ QC
CREATE TABLE IF NOT EXISTS qc_skip_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_name text NOT NULL,
  skipped_by text NOT NULL,
  total_items integer NOT NULL DEFAULT 0,
  item_details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- เปิด RLS
ALTER TABLE qc_skip_logs ENABLE ROW LEVEL SECURITY;

-- Policy: อนุญาต authenticated users ทั้งหมด
CREATE POLICY "Allow all for authenticated" ON qc_skip_logs
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- Index สำหรับค้นหาตาม work_order_name
CREATE INDEX idx_qc_skip_logs_wo ON qc_skip_logs (work_order_name);
CREATE INDEX idx_qc_skip_logs_created ON qc_skip_logs (created_at DESC);
