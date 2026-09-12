-- Add the existing HR department master to Knowledge Hub items.
ALTER TABLE public.kb_items
  ADD COLUMN IF NOT EXISTS department_id UUID
  REFERENCES public.hr_departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kb_items_department
  ON public.kb_items(department_id);

