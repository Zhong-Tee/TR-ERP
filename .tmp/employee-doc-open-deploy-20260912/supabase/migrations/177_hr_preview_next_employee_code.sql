-- ดูรหัสพนักงานถัดไป (ไม่กินลำดับ) สำหรับแสดงในฟอร์มเพิ่มพนักงาน
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
  )::text, 6, '0');
$$;

GRANT EXECUTE ON FUNCTION public.hr_preview_next_employee_code() TO authenticated;
