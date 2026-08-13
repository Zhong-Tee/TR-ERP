-- HR: monthly payroll handoff for approved leave that exceeds paid entitlement.
CREATE TABLE IF NOT EXISTS public.hr_leave_payroll_deductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  payroll_month DATE NOT NULL CHECK (payroll_month = date_trunc('month', payroll_month)::date),
  excess_days NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (excess_days >= 0),
  salary_base NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (salary_base >= 0),
  deduction_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (deduction_amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'sent')),
  note TEXT,
  confirmed_by UUID REFERENCES public.hr_employees(id),
  confirmed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, payroll_month)
);

ALTER TABLE public.hr_leave_payroll_deductions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "leave_payroll_deduction_select" ON public.hr_leave_payroll_deductions;
DROP POLICY IF EXISTS "leave_payroll_deduction_manage" ON public.hr_leave_payroll_deductions;
CREATE POLICY "leave_payroll_deduction_select" ON public.hr_leave_payroll_deductions
  FOR SELECT TO authenticated USING (public.hr_is_admin());
CREATE POLICY "leave_payroll_deduction_manage" ON public.hr_leave_payroll_deductions
  FOR ALL TO authenticated USING (public.hr_is_admin()) WITH CHECK (public.hr_is_admin());

CREATE INDEX IF NOT EXISTS idx_hr_leave_payroll_deductions_month
  ON public.hr_leave_payroll_deductions (payroll_month, status);
