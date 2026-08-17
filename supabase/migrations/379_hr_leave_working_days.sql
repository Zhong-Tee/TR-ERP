-- คำนวณวันลาเต็มวันจากวันทำงานจริงของพนักงาน
-- ไม่แก้ข้อมูลใบลาเดิมย้อนหลัง แต่บังคับใช้กับรายการที่สร้าง/แก้ไขช่วงวันหลัง migration นี้
CREATE OR REPLACE FUNCTION hr_set_leave_working_days()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_work_days TEXT;
  v_working_days INTEGER;
BEGIN
  IF NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'วันสิ้นสุดการลาต้องไม่น้อยกว่าวันเริ่มต้น';
  END IF;

  SELECT COALESCE(employee_schedule.work_days, default_schedule.work_days, '1,2,3,4,5,6')
  INTO v_work_days
  FROM hr_employees employee
  LEFT JOIN hr_work_schedules employee_schedule
    ON employee_schedule.id = employee.work_schedule_id
  LEFT JOIN LATERAL (
    SELECT schedule.work_days
    FROM hr_work_schedules schedule
    WHERE schedule.is_default = true
    ORDER BY schedule.created_at
    LIMIT 1
  ) default_schedule ON true
  WHERE employee.id = NEW.employee_id;

  SELECT COUNT(*)::INTEGER
  INTO v_working_days
  FROM generate_series(NEW.start_date, NEW.end_date, INTERVAL '1 day') series(work_date)
  LEFT JOIN hr_employee_work_calendar override_day
    ON override_day.employee_id = NEW.employee_id
   AND override_day.work_date = series.work_date::DATE
  LEFT JOIN hr_company_holidays holiday
    ON holiday.holiday_date = series.work_date::DATE
  WHERE CASE
    -- รายการกำหนดพิเศษของพนักงานมีลำดับสูงสุด
    WHEN override_day.id IS NOT NULL THEN override_day.day_type = 'work'
    WHEN holiday.id IS NOT NULL THEN false
    ELSE EXTRACT(ISODOW FROM series.work_date)::INTEGER = ANY (
      string_to_array(v_work_days, ',')::INTEGER[]
    )
  END;

  IF v_working_days = 0 THEN
    RAISE EXCEPTION 'ช่วงวันที่เลือกไม่มีวันทำงาน ไม่สามารถบันทึกใบลาได้';
  END IF;

  IF COALESCE(NEW.leave_mode, 'full_day') = 'full_day' THEN
    NEW.total_days := v_working_days;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_leave_working_days ON hr_leave_requests;
CREATE TRIGGER trg_hr_leave_working_days
BEFORE INSERT OR UPDATE OF employee_id, start_date, end_date, leave_mode
ON hr_leave_requests
FOR EACH ROW
EXECUTE FUNCTION hr_set_leave_working_days();

-- คำนวณซ้ำตอนอนุมัติ เผื่อมีการเพิ่มวันหยุดหรือแก้ตารางหลังยื่นคำขอ
DROP TRIGGER IF EXISTS trg_hr_leave_working_days_on_approval ON hr_leave_requests;
CREATE TRIGGER trg_hr_leave_working_days_on_approval
BEFORE UPDATE OF status
ON hr_leave_requests
FOR EACH ROW
WHEN (NEW.status = 'approved' AND OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION hr_set_leave_working_days();

COMMENT ON FUNCTION hr_set_leave_working_days() IS
  'นับเฉพาะวันทำงานตาม override รายบุคคล วันหยุดบริษัท และตารางทำงาน ก่อนบันทึกใบลา';
