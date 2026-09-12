ALTER TABLE public.hr_warnings
  DROP CONSTRAINT IF EXISTS hr_warnings_warning_level_check;

ALTER TABLE public.hr_warnings
  ADD CONSTRAINT hr_warnings_warning_level_check
  CHECK (warning_level IN ('verbal', 'verbal_2', 'written_1', 'written_2', 'final'));

ALTER TABLE public.hr_warnings
  ADD COLUMN IF NOT EXISTS reference_warning_id UUID
  REFERENCES public.hr_warnings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_hr_warnings_reference
  ON public.hr_warnings(reference_warning_id);

COMMENT ON COLUMN public.hr_warnings.reference_warning_id IS
  'Previous warning copied as the basis for this follow-up warning';
