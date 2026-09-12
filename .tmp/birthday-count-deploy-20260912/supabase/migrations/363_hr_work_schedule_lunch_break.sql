-- Add a lunch break to each work schedule. Hourly leave overlapping this range
-- is calculated using working minutes only.
ALTER TABLE public.hr_work_schedules
  ADD COLUMN IF NOT EXISTS lunch_start TIME NOT NULL DEFAULT '12:00',
  ADD COLUMN IF NOT EXISTS lunch_end TIME NOT NULL DEFAULT '13:00';

ALTER TABLE public.hr_work_schedules
  DROP CONSTRAINT IF EXISTS hr_work_schedules_lunch_range_check;

ALTER TABLE public.hr_work_schedules
  ADD CONSTRAINT hr_work_schedules_lunch_range_check
  CHECK (lunch_end > lunch_start);

COMMENT ON COLUMN public.hr_work_schedules.lunch_start IS 'Start of unpaid lunch break';
COMMENT ON COLUMN public.hr_work_schedules.lunch_end IS 'End of unpaid lunch break';
