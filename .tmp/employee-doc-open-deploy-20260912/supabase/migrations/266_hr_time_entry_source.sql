-- =============================================================================
-- HR Time Entries: เพิ่มคอลัมน์ source แยกแหล่งที่มาของบันทึกเวลา
--   mobile = แตะผ่านแอปมือถือ (GPS+รูป), device = นำเข้าจากเครื่องสแกนนิ้ว, manual = HR กรอกเอง
-- IDEMPOTENT: safe to re-run
-- =============================================================================

ALTER TABLE hr_time_entries
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'mobile';

-- เผื่อรันซ้ำหลังเคยเพิ่ม constraint แล้ว: ลบก่อนค่อยสร้างใหม่
ALTER TABLE hr_time_entries DROP CONSTRAINT IF EXISTS hr_time_entries_source_chk;
ALTER TABLE hr_time_entries
  ADD CONSTRAINT hr_time_entries_source_chk CHECK (source IN ('mobile','device','manual'));

CREATE INDEX IF NOT EXISTS idx_hr_time_entries_source ON hr_time_entries(source);
