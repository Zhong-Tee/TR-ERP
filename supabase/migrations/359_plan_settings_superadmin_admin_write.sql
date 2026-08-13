-- Keep Plan settings readable according to the existing SELECT policy, but
-- restrict every write operation to the current superadmin/admin roles only.
DROP POLICY IF EXISTS "Authenticated users can insert plan_settings" ON public.plan_settings;
DROP POLICY IF EXISTS "Authenticated users can update plan_settings" ON public.plan_settings;
DROP POLICY IF EXISTS "Authenticated users can delete plan_settings" ON public.plan_settings;
DROP POLICY IF EXISTS "plan_settings_write" ON public.plan_settings;
DROP POLICY IF EXISTS "plan_settings_insert" ON public.plan_settings;
DROP POLICY IF EXISTS "plan_settings_update" ON public.plan_settings;
DROP POLICY IF EXISTS "plan_settings_delete" ON public.plan_settings;

CREATE POLICY "plan_settings_insert"
  ON public.plan_settings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin')
    )
  );

CREATE POLICY "plan_settings_update"
  ON public.plan_settings
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin')
    )
  );

CREATE POLICY "plan_settings_delete"
  ON public.plan_settings
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.us_users u
      WHERE u.id = auth.uid()
        AND u.role IN ('superadmin', 'admin')
    )
  );
