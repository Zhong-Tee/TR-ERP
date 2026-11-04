-- Per-user Machinery inspection visibility and common incident titles per machine.
BEGIN;

ALTER TABLE public.pr_machinery_machines
  ADD COLUMN IF NOT EXISTS incident_titles text[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE TABLE IF NOT EXISTS public.pr_machinery_inspection_users (
  user_id uuid PRIMARY KEY REFERENCES public.us_users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.us_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.pr_machinery_inspection_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_machinery_inspection_users_select ON public.pr_machinery_inspection_users;
CREATE POLICY pr_machinery_inspection_users_select
  ON public.pr_machinery_inspection_users
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician'])
  );

DROP POLICY IF EXISTS pr_machinery_inspection_users_write ON public.pr_machinery_inspection_users;
CREATE POLICY pr_machinery_inspection_users_write
  ON public.pr_machinery_inspection_users
  FOR ALL TO authenticated
  USING (check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician']))
  WITH CHECK (check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician']));

COMMIT;
