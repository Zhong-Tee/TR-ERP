-- =============================================================================
-- จำกัดสิทธิ์ "อนุมัติ/ปฏิเสธ" ใบลา ให้เฉพาะ superadmin / admin / hr เท่านั้น
--   ใช้ BEFORE UPDATE trigger คุมการเปลี่ยน status โดยตรง (ระดับ DB — กันเลี่ยงผ่าน API)
--   - ผู้มีสิทธิ์อนุมัติ: เปลี่ยนสถานะได้ทุกกรณี
--   - พนักงานเจ้าของใบ: ยกเลิก (cancelled) ใบที่ยัง pending ของตัวเองได้เท่านั้น
--   - การอัปเดตฟิลด์อื่นที่ไม่แตะ status (เช่นแนบใบรับรองแพทย์) ยังทำได้ตาม RLS เดิม
-- IDEMPOTENT: safe to re-run
-- =============================================================================

CREATE OR REPLACE FUNCTION hr_can_approve_leave() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin','admin','hr')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION hr_leave_guard_status() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF hr_can_approve_leave() THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'cancelled' AND OLD.status = 'pending' AND OLD.employee_id = hr_my_employee_id() THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนสถานะใบลา (เฉพาะ superadmin/admin/hr เท่านั้น)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_hr_leave_guard_status ON hr_leave_requests;
CREATE TRIGGER trg_hr_leave_guard_status
  BEFORE UPDATE ON hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION hr_leave_guard_status();
