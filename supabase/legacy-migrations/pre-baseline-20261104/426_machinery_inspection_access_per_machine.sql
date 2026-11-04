-- Scope additional inspection users to individual machines.
BEGIN;

CREATE TABLE IF NOT EXISTS public.pr_machinery_inspection_machine_users (
  machine_id uuid NOT NULL REFERENCES public.pr_machinery_machines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.us_users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES public.us_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (machine_id, user_id)
);

-- Preserve the previous global grants by applying them to every current machine.
INSERT INTO public.pr_machinery_inspection_machine_users (machine_id, user_id, created_by, created_at)
SELECT machine.id, access.user_id, access.created_by, access.created_at
FROM public.pr_machinery_machines machine
CROSS JOIN public.pr_machinery_inspection_users access
ON CONFLICT (machine_id, user_id) DO NOTHING;

ALTER TABLE public.pr_machinery_inspection_machine_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_machinery_inspection_machine_users_select ON public.pr_machinery_inspection_machine_users;
CREATE POLICY pr_machinery_inspection_machine_users_select
  ON public.pr_machinery_inspection_machine_users
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician'])
  );

DROP POLICY IF EXISTS pr_machinery_inspection_machine_users_write ON public.pr_machinery_inspection_machine_users;
CREATE POLICY pr_machinery_inspection_machine_users_write
  ON public.pr_machinery_inspection_machine_users
  FOR ALL TO authenticated
  USING (check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician']))
  WITH CHECK (check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'technician']));

COMMIT;
