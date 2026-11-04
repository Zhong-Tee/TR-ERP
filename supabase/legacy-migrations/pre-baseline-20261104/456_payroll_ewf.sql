-- Employee Welfare Fund (EWF): 0.25% of base salary + position allowance.

ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS ewf_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (ewf_opening_balance >= 0);

ALTER TABLE public.hr_payroll_items
  ADD COLUMN IF NOT EXISTS ewf NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (ewf >= 0),
  ADD COLUMN IF NOT EXISTS ewf_opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (ewf_opening_balance >= 0);

ALTER TABLE public.hr_payroll_items
  DROP COLUMN IF EXISTS net_pay,
  DROP COLUMN IF EXISTS total_deduction;

ALTER TABLE public.hr_payroll_items
  ADD COLUMN total_deduction NUMERIC(12,2)
    GENERATED ALWAYS AS (
      personal_tax + social_security + ewf + savings + student_loan
      + company_loan + leave_deduction + other_deduction
    ) STORED,
  ADD COLUMN net_pay NUMERIC(12,2)
    GENERATED ALWAYS AS (
      (base_salary + position_allowance + other_income)
      - (personal_tax + social_security + ewf + savings + student_loan
        + company_loan + leave_deduction + other_deduction)
    ) STORED;

COMMENT ON COLUMN public.hr_payroll_items.ewf IS
  'EWF ประจำงวด คำนวณจาก (ฐานเงินเดือน + เงินพิเศษ/ประจำตำแหน่ง) × 0.25%';
COMMENT ON COLUMN public.hr_employees.ewf_opening_balance IS
  'ยอดสะสม EWF ก่อนเริ่มใช้ระบบ';

NOTIFY pgrst, 'reload schema';
