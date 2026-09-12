-- Account payroll: companies, employee deductions, monthly snapshots and menu access.

CREATE TABLE IF NOT EXISTS public.hr_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_key TEXT NOT NULL UNIQUE,
  name_th TEXT NOT NULL,
  name_en TEXT,
  address TEXT,
  tax_id TEXT,
  branch TEXT DEFAULT 'สำนักงานใหญ่',
  phone TEXT,
  logo_url TEXT,
  signatory_name TEXT,
  signatory_title TEXT,
  signature_url TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.hr_companies (company_key, name_th, name_en, address, tax_id, branch, phone)
VALUES
  ('tr', 'ห้างหุ้นส่วนจำกัด ทีอาร์ คิดส์ช็อป', 'TR Kidsshop Limited Partnership', '1641,1643 ชั้นที่ 3 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160', '0103563005345', 'สำนักงานใหญ่', '082-934-1288'),
  ('odf', 'บริษัท ออนดีมานด์ แฟคตอรี่ จำกัด', 'Ondemand Factory Co., Ltd.', '1641,1643 ถนนเพชรเกษม แขวงหลักสอง เขตบางแค กรุงเทพมหานคร 10160', '0105564109286', 'สำนักงานใหญ่', '082-934-1288')
ON CONFLICT (company_key) DO NOTHING;

ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.hr_companies(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS monthly_personal_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_personal_tax >= 0),
  ADD COLUMN IF NOT EXISTS monthly_social_security NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_social_security >= 0),
  ADD COLUMN IF NOT EXISTS monthly_student_loan NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_student_loan >= 0),
  ADD COLUMN IF NOT EXISTS monthly_company_loan NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_company_loan >= 0);

CREATE TABLE IF NOT EXISTS public.hr_payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_month DATE NOT NULL CHECK (payroll_month = date_trunc('month', payroll_month)::date),
  company_id UUID NOT NULL REFERENCES public.hr_companies(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  payment_date DATE,
  confirmed_by UUID REFERENCES public.us_users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payroll_month, company_id)
);

CREATE TABLE IF NOT EXISTS public.hr_payroll_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_run_id UUID NOT NULL REFERENCES public.hr_payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES public.hr_employees(id),
  employee_code TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  department_position TEXT,
  base_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  position_allowance NUMERIC(12,2) NOT NULL DEFAULT 0,
  personal_tax NUMERIC(12,2) NOT NULL DEFAULT 0,
  social_security NUMERIC(12,2) NOT NULL DEFAULT 0,
  student_loan NUMERIC(12,2) NOT NULL DEFAULT 0,
  company_loan NUMERIC(12,2) NOT NULL DEFAULT 0,
  leave_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_income NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_deduction NUMERIC(12,2) NOT NULL DEFAULT 0,
  gross_income NUMERIC(12,2) GENERATED ALWAYS AS (base_salary + position_allowance + other_income) STORED,
  total_deduction NUMERIC(12,2) GENERATED ALWAYS AS (personal_tax + social_security + student_loan + company_loan + leave_deduction + other_deduction) STORED,
  net_pay NUMERIC(12,2) GENERATED ALWAYS AS ((base_salary + position_allowance + other_income) - (personal_tax + social_security + student_loan + company_loan + leave_deduction + other_deduction)) STORED,
  company_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payroll_run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_payroll_runs_month_company ON public.hr_payroll_runs(payroll_month, company_id);
CREATE INDEX IF NOT EXISTS idx_hr_payroll_items_employee ON public.hr_payroll_items(employee_id, payroll_run_id);

CREATE OR REPLACE FUNCTION public.hr_payroll_role_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'account')
  );
$$;

CREATE OR REPLACE FUNCTION public.hr_company_manage_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND is_active IS TRUE AND role IN ('superadmin', 'admin', 'hr')
  );
$$;

ALTER TABLE public.hr_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_payroll_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_companies_select ON public.hr_companies;
CREATE POLICY hr_companies_select ON public.hr_companies FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS hr_companies_manage ON public.hr_companies;
CREATE POLICY hr_companies_manage ON public.hr_companies FOR ALL TO authenticated
  USING (public.hr_company_manage_allowed()) WITH CHECK (public.hr_company_manage_allowed());

DROP POLICY IF EXISTS hr_payroll_runs_manage ON public.hr_payroll_runs;
CREATE POLICY hr_payroll_runs_manage ON public.hr_payroll_runs FOR ALL TO authenticated
  USING (public.hr_payroll_role_allowed()) WITH CHECK (public.hr_payroll_role_allowed());
DROP POLICY IF EXISTS hr_payroll_items_manage ON public.hr_payroll_items;
CREATE POLICY hr_payroll_items_manage ON public.hr_payroll_items FOR ALL TO authenticated
  USING (public.hr_payroll_role_allowed()) WITH CHECK (public.hr_payroll_role_allowed());

GRANT SELECT ON public.hr_companies TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.hr_companies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hr_payroll_runs, public.hr_payroll_items TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_payroll_role_allowed() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_company_manage_allowed() TO authenticated;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('superadmin', 'account-payroll', 'บัญชี · เงินเดือน', TRUE),
  ('account', 'account-payroll', 'บัญชี · เงินเดือน', TRUE),
  ('admin', 'account-payroll', 'บัญชี · เงินเดือน', FALSE)
ON CONFLICT (role, menu_key) DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = EXCLUDED.has_access,
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';
