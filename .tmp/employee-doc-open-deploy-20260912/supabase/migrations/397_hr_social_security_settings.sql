-- Global Social Security contribution settings used by Account > Payroll.
CREATE TABLE IF NOT EXISTS public.hr_social_security_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id IS TRUE),
  contribution_rate NUMERIC(5,2) NOT NULL DEFAULT 5 CHECK (contribution_rate >= 0 AND contribution_rate <= 100),
  maximum_wage_base NUMERIC(12,2) NOT NULL DEFAULT 17500 CHECK (maximum_wage_base >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL
);

INSERT INTO public.hr_social_security_settings (id, contribution_rate, maximum_wage_base)
VALUES (TRUE, 5, 17500)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.hr_social_security_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_social_security_settings_select ON public.hr_social_security_settings;
CREATE POLICY hr_social_security_settings_select ON public.hr_social_security_settings
  FOR SELECT TO authenticated USING (TRUE);

DROP POLICY IF EXISTS hr_social_security_settings_manage ON public.hr_social_security_settings;
CREATE POLICY hr_social_security_settings_manage ON public.hr_social_security_settings
  FOR ALL TO authenticated
  USING (public.hr_company_manage_allowed())
  WITH CHECK (public.hr_company_manage_allowed());

GRANT SELECT, INSERT, UPDATE ON public.hr_social_security_settings TO authenticated;

NOTIFY pgrst, 'reload schema';
