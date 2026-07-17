-- plan_jobs: โน้ตติดตามของหัวหน้างานต่อแผนก (ใกล้เสร็จ / อาจจะช้า)
-- เก็บเป็น JSONB { "<แผนก>": "almost" | "slow" } เพื่อบันทึกว่าเคยติดตามแล้วได้คำตอบใด
ALTER TABLE plan_jobs ADD COLUMN IF NOT EXISTS follow_notes JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN plan_jobs.follow_notes IS
  'โน้ตติดตามของหัวหน้างานต่อแผนก: { "<dept>": "almost" (ใกล้เสร็จ) | "slow" (อาจจะช้า) } (284)';
