-- Persist the display order of payroll companies.

ALTER TABLE public.hr_companies
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY name_th, created_at, id)::INTEGER AS position
  FROM public.hr_companies
)
UPDATE public.hr_companies AS company
SET sort_order = ranked.position
FROM ranked
WHERE company.id = ranked.id
  AND company.sort_order = 0;

CREATE INDEX IF NOT EXISTS idx_hr_companies_sort_order
  ON public.hr_companies (sort_order, name_th);

CREATE OR REPLACE FUNCTION public.reorder_hr_companies(p_company_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  requested_count INTEGER := COALESCE(array_length(p_company_ids, 1), 0);
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count
  FROM public.hr_companies
  WHERE id = ANY(COALESCE(p_company_ids, ARRAY[]::UUID[]));

  IF requested_count = 0 OR existing_count <> requested_count THEN
    RAISE EXCEPTION 'Invalid company order';
  END IF;

  UPDATE public.hr_companies AS company
  SET sort_order = ordered.position,
      updated_at = NOW()
  FROM unnest(p_company_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE company.id = ordered.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reorder_hr_companies(UUID[]) TO authenticated;

COMMENT ON COLUMN public.hr_companies.sort_order IS
  'User-managed display order for payroll company selectors and settings';

NOTIFY pgrst, 'reload schema';
