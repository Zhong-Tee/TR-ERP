-- Production onboarding assessment for new employees.
ALTER TABLE plan_employee_profiles
  ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (onboarding_status IN ('not_required','pending','probation','passed','failed')),
  ADD COLUMN IF NOT EXISTS review_date DATE,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS onboarding_note TEXT;

CREATE INDEX IF NOT EXISTS idx_plan_employee_profiles_onboarding
  ON plan_employee_profiles(onboarding_status);

