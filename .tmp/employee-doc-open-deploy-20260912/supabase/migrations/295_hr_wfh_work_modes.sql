-- รูปแบบการทำงานและคำขอ WFH
ALTER TABLE hr_employees
  ADD COLUMN IF NOT EXISTS work_mode TEXT NOT NULL DEFAULT 'office';

ALTER TABLE hr_employees DROP CONSTRAINT IF EXISTS hr_employees_work_mode_check;
ALTER TABLE hr_employees ADD CONSTRAINT hr_employees_work_mode_check
  CHECK (work_mode IN ('office', 'hybrid', 'wfh'));

CREATE TABLE IF NOT EXISTS hr_wfh_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  reject_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_hr_wfh_requests_employee_date
  ON hr_wfh_requests(employee_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_hr_wfh_requests_status ON hr_wfh_requests(status);

ALTER TABLE hr_wfh_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hr_wfh_requests_select" ON hr_wfh_requests;
DROP POLICY IF EXISTS "hr_wfh_requests_insert" ON hr_wfh_requests;
DROP POLICY IF EXISTS "hr_wfh_requests_update" ON hr_wfh_requests;
CREATE POLICY "hr_wfh_requests_select" ON hr_wfh_requests FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_wfh_requests_insert" ON hr_wfh_requests FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = hr_my_employee_id()
    AND EXISTS (SELECT 1 FROM hr_employees e WHERE e.id = hr_wfh_requests.employee_id AND e.work_mode = 'hybrid')
  );
CREATE POLICY "hr_wfh_requests_update" ON hr_wfh_requests FOR UPDATE TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

DROP TRIGGER IF EXISTS trg_hr_wfh_requests_updated ON hr_wfh_requests;
CREATE TRIGGER trg_hr_wfh_requests_updated BEFORE UPDATE ON hr_wfh_requests
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

CREATE OR REPLACE FUNCTION hr_wfh_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'wfh_approval_pending', 'มีคำขอ WFH รออนุมัติ',
      'พนักงานส่งคำขอ WFH วันที่ ' || NEW.start_date::text || ' ถึง ' || NEW.end_date::text,
      '/employee?notif=pending', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin', 'admin', 'hr');
  ELSIF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'wfh_result',
      CASE WHEN NEW.status = 'approved' THEN 'คำขอ WFH ได้รับการอนุมัติ' ELSE 'คำขอ WFH ถูกปฏิเสธ' END,
      CASE WHEN NEW.status = 'approved' THEN 'คุณสามารถลงเวลาแบบ WFH ในช่วงวันที่อนุมัติได้'
           ELSE COALESCE('เหตุผล: ' || NEW.reject_reason, 'คำขอ WFH ไม่ได้รับการอนุมัติ') END,
      '/employee?notif=result', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_wfh_notify ON hr_wfh_requests;
CREATE TRIGGER trg_hr_wfh_notify AFTER INSERT OR UPDATE OF status ON hr_wfh_requests
  FOR EACH ROW EXECUTE FUNCTION hr_wfh_notify();

ALTER TABLE hr_time_entries
  ADD COLUMN IF NOT EXISTS work_location_type TEXT NOT NULL DEFAULT 'office',
  ADD COLUMN IF NOT EXISTS wfh_request_id UUID REFERENCES hr_wfh_requests(id) ON DELETE SET NULL;

ALTER TABLE hr_time_entries DROP CONSTRAINT IF EXISTS hr_time_entries_work_location_type_check;
ALTER TABLE hr_time_entries ADD CONSTRAINT hr_time_entries_work_location_type_check
  CHECK (work_location_type IN ('office', 'wfh_approved', 'wfh_permanent'));

CREATE OR REPLACE FUNCTION hr_validate_time_entry_work_location() RETURNS TRIGGER AS $$
DECLARE
  v_mode TEXT;
  v_request_id UUID;
BEGIN
  -- ข้อมูลจากเครื่องสแกน/HR ไม่ผ่านขั้นตอน GPS บน Employee Portal
  IF COALESCE(NEW.source, 'mobile') <> 'mobile' THEN
    NEW.work_location_type := 'office';
    NEW.wfh_request_id := NULL;
    RETURN NEW;
  END IF;
  SELECT work_mode INTO v_mode FROM hr_employees WHERE id = NEW.employee_id;
  IF v_mode = 'wfh' THEN
    NEW.work_location_type := 'wfh_permanent';
    NEW.wfh_request_id := NULL;
  ELSIF v_mode = 'hybrid' AND NEW.location_id IS NULL THEN
    SELECT id INTO v_request_id FROM hr_wfh_requests
    WHERE employee_id = NEW.employee_id AND status = 'approved'
      AND NEW.work_date BETWEEN start_date AND end_date
    ORDER BY approved_at DESC NULLS LAST LIMIT 1;
    IF v_request_id IS NULL THEN
      RAISE EXCEPTION 'ไม่พบคำขอ WFH ที่อนุมัติสำหรับวันนี้';
    END IF;
    NEW.work_location_type := 'wfh_approved';
    NEW.wfh_request_id := v_request_id;
  ELSE
    IF NEW.location_id IS NULL THEN
      RAISE EXCEPTION 'การลงเวลาเข้าออฟฟิศต้องระบุจุดพิกัดสำนักงาน';
    END IF;
    NEW.work_location_type := 'office';
    NEW.wfh_request_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_validate_time_entry_work_location ON hr_time_entries;
CREATE TRIGGER trg_hr_validate_time_entry_work_location BEFORE INSERT ON hr_time_entries
  FOR EACH ROW EXECUTE FUNCTION hr_validate_time_entry_work_location();

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_wfh_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
