-- เพิ่มประเภทคำขอ WFH และคงความเข้ากันได้กับคำขอเดิม
ALTER TABLE hr_wfh_requests
  ADD COLUMN IF NOT EXISTS wfh_type TEXT NOT NULL DEFAULT 'other';

ALTER TABLE hr_wfh_requests
  DROP CONSTRAINT IF EXISTS hr_wfh_requests_type_check;

ALTER TABLE hr_wfh_requests
  ADD CONSTRAINT hr_wfh_requests_type_check
  CHECK (wfh_type IN ('afternoon_shift', 'sunday_work', 'other'));

COMMENT ON COLUMN hr_wfh_requests.wfh_type IS
  'ประเภท WFH: afternoon_shift=เข้างานกะบ่าย, sunday_work=ทำงานวันอาทิตย์, other=อื่นๆ';

CREATE INDEX IF NOT EXISTS idx_hr_wfh_requests_type
  ON hr_wfh_requests(wfh_type);
