-- =============================================================================
-- รหัสพนักงาน: ปรับเป็น EMP + เลข 5 หลักให้สม่ำเสมอ (เดิม 6 หลัก + ของเก่า 3 หลัก)
--   - แก้ trigger สร้างรหัสอัตโนมัติ (176) และ RPC preview (177) → pad 5 หลัก
--   - แปลงรหัสเดิมทั้งหมดให้เป็น 5 หลัก: EMP001 → EMP00001, EMP000002 → EMP00002
-- ปลอดภัย: employee_code เป็นแค่ข้อความ (ตารางอื่นอ้างอิงด้วย id/UUID ไม่ใช่รหัสนี้)
-- IDEMPOTENT: รันซ้ำได้
-- =============================================================================

-- 1. แปลงรหัสเดิมให้เป็น 5 หลัก
UPDATE hr_employees
SET employee_code = 'EMP' || lpad(substring(employee_code FROM 4)::bigint::text, 5, '0')
WHERE employee_code ~ '^EMP[0-9]+$'
  AND employee_code <> 'EMP' || lpad(substring(employee_code FROM 4)::bigint::text, 5, '0');

-- 2. trigger สร้างรหัสอัตโนมัติตอน insert → 5 หลัก
CREATE OR REPLACE FUNCTION hr_assign_employee_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.employee_code IS NULL OR btrim(NEW.employee_code) = '') THEN
    NEW.employee_code := 'EMP' || lpad(nextval('hr_employee_code_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- 3. RPC preview รหัสถัดไป → 5 หลัก
CREATE OR REPLACE FUNCTION public.hr_preview_next_employee_code()
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 'EMP' || lpad((
    GREATEST(
      COALESCE((
        SELECT MAX(substring(e.employee_code FROM 4)::bigint)
        FROM hr_employees e
        WHERE e.employee_code ~ '^EMP[0-9]+$'
      ), 0),
      COALESCE((
        SELECT s.last_value
        FROM pg_sequences s
        WHERE s.schemaname = 'public'
          AND s.sequencename = 'hr_employee_code_seq'
      ), 0)
    ) + 1
  )::text, 5, '0');
$$;

GRANT EXECUTE ON FUNCTION public.hr_preview_next_employee_code() TO authenticated;
