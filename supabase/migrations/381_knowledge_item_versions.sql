-- Move version history from Task records to Knowledge Hub items.

DROP TRIGGER IF EXISTS trg_kb_tasks_version ON public.kb_tasks;
DROP FUNCTION IF EXISTS public.kb_save_task_version();
DROP TABLE IF EXISTS public.kb_task_versions;

CREATE TABLE IF NOT EXISTS public.kb_item_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.kb_items(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  content TEXT,
  category_id UUID REFERENCES public.kb_categories(id) ON DELETE SET NULL,
  machine_id UUID REFERENCES public.pr_machinery_machines(id) ON DELETE SET NULL,
  department_id UUID REFERENCES public.hr_departments(id) ON DELETE SET NULL,
  access_level TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  allowed_roles TEXT[] NOT NULL DEFAULT '{}',
  saved_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, version_no)
);

ALTER TABLE public.kb_item_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_item_versions_superadmin_all ON public.kb_item_versions;
CREATE POLICY kb_item_versions_superadmin_all ON public.kb_item_versions
FOR ALL TO authenticated
USING (public.kb_is_superadmin())
WITH CHECK (public.kb_is_superadmin());

CREATE INDEX IF NOT EXISTS idx_kb_item_versions_item
  ON public.kb_item_versions(item_id, version_no DESC);

CREATE OR REPLACE FUNCTION public.kb_create_item_version(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  item_row public.kb_items%ROWTYPE;
  next_version INTEGER;
BEGIN
  SELECT * INTO item_row FROM public.kb_items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge item not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_item_id::text));
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_version
  FROM public.kb_item_versions WHERE item_id = p_item_id;

  INSERT INTO public.kb_item_versions (
    item_id, version_no, title, description, content, category_id, machine_id,
    department_id, access_level, tags, allowed_roles, saved_by
  ) VALUES (
    item_row.id, next_version, item_row.title, item_row.description, item_row.content,
    item_row.category_id, item_row.machine_id, item_row.department_id,
    item_row.access_level, item_row.tags,
    ARRAY(SELECT role FROM public.kb_item_roles WHERE item_id = p_item_id ORDER BY role),
    item_row.updated_by
  );
  RETURN next_version;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kb_create_item_version(UUID) TO authenticated;

-- Give existing knowledge records an initial version.
DO $$
DECLARE item_id UUID;
BEGIN
  FOR item_id IN SELECT id FROM public.kb_items LOOP
    IF NOT EXISTS (SELECT 1 FROM public.kb_item_versions WHERE kb_item_versions.item_id = item_id) THEN
      PERFORM public.kb_create_item_version(item_id);
    END IF;
  END LOOP;
END $$;

