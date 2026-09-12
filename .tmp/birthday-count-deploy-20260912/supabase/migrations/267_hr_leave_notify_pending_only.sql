-- =============================================================================
-- แก้ trigger แจ้งเตือนใบลา: ตอน INSERT ให้แจ้ง "รออนุมัติ" เฉพาะใบที่ status = 'pending'
--   เพื่อรองรับการนำเข้าใบลาย้อนหลังแบบ approved (จะได้ไม่สแปมแจ้งเตือน HR)
-- IDEMPOTENT: safe to re-run (CREATE OR REPLACE)
-- =============================================================================

CREATE OR REPLACE FUNCTION hr_leave_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'leave_approval_pending', 'มีใบลารออนุมัติ',
      NEW.reason, '/hr/leave', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin','admin','admin-tr','hr')
    LIMIT 5;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'leave_result',
      CASE WHEN NEW.status = 'approved' THEN 'ใบลาได้รับการอนุมัติ' ELSE 'ใบลาถูกปฏิเสธ' END,
      COALESCE(NEW.reject_reason, ''),
      '/employee/leave',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
