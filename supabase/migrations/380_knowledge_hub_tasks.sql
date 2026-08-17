-- Knowledge Hub tasks with automatic, restorable version history.

CREATE SEQUENCE IF NOT EXISTS public.kb_task_code_seq START 1;

CREATE TABLE IF NOT EXISTS public.kb_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo', 'in_progress', 'review', 'active')),
  due_date DATE,
  created_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kb_task_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.kb_tasks(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  due_date DATE,
  saved_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, version_no)
);

CREATE OR REPLACE FUNCTION public.kb_set_task_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.task_code IS NULL OR btrim(NEW.task_code) = '' THEN
    NEW.task_code := 'TASK-' || lpad(nextval('public.kb_task_code_seq')::text, 6, '0');
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_tasks_defaults ON public.kb_tasks;
CREATE TRIGGER trg_kb_tasks_defaults
BEFORE INSERT OR UPDATE ON public.kb_tasks
FOR EACH ROW EXECUTE FUNCTION public.kb_set_task_defaults();

CREATE OR REPLACE FUNCTION public.kb_save_task_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  next_version INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.id::text));
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_version
  FROM public.kb_task_versions WHERE task_id = NEW.id;

  INSERT INTO public.kb_task_versions
    (task_id, version_no, title, description, status, due_date, saved_by)
  VALUES
    (NEW.id, next_version, NEW.title, NEW.description, NEW.status, NEW.due_date, NEW.updated_by);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_tasks_version ON public.kb_tasks;
CREATE TRIGGER trg_kb_tasks_version
AFTER INSERT OR UPDATE ON public.kb_tasks
FOR EACH ROW EXECUTE FUNCTION public.kb_save_task_version();

CREATE INDEX IF NOT EXISTS idx_kb_tasks_status ON public.kb_tasks(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_task_versions_task ON public.kb_task_versions(task_id, version_no DESC);

ALTER TABLE public.kb_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_task_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_tasks_superadmin_all ON public.kb_tasks;
CREATE POLICY kb_tasks_superadmin_all ON public.kb_tasks
FOR ALL TO authenticated
USING (public.kb_is_superadmin())
WITH CHECK (public.kb_is_superadmin());

DROP POLICY IF EXISTS kb_task_versions_superadmin_all ON public.kb_task_versions;
CREATE POLICY kb_task_versions_superadmin_all ON public.kb_task_versions
FOR ALL TO authenticated
USING (public.kb_is_superadmin())
WITH CHECK (public.kb_is_superadmin());

