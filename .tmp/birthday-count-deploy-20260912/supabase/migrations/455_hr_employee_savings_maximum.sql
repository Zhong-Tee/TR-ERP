-- เพดานยอดเงินสะสมรวมรายพนักงาน (NULL = ไม่จำกัด)

ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS savings_maximum NUMERIC(12,2)
  CHECK (savings_maximum IS NULL OR savings_maximum >= 0);

COMMENT ON COLUMN public.hr_employees.savings_maximum IS
  'เพดานยอดเงินสะสมรวม เมื่อถึงเพดานระบบเงินเดือนจะหยุดหัก; NULL = ไม่จำกัด';

NOTIFY pgrst, 'reload schema';
