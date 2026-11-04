-- Allow the production role to enter and operate the Packing page.

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('production', 'packing', 'แพ็คสินค้า', true)
ON CONFLICT (role, menu_key)
DO UPDATE SET
  menu_name = EXCLUDED.menu_name,
  has_access = true;

DROP POLICY IF EXISTS "Packing staff can manage logs" ON public.pk_packing_logs;
CREATE POLICY "Packing staff can manage logs"
  ON public.pk_packing_logs FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  );

DROP POLICY IF EXISTS "Packing staff can manage packing videos" ON public.pk_packing_videos;
CREATE POLICY "Packing staff can manage packing videos"
  ON public.pk_packing_videos FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  );

DROP POLICY IF EXISTS "Packing staff can manage unit scans" ON public.pk_packing_unit_scans;
CREATE POLICY "Packing staff can manage unit scans"
  ON public.pk_packing_unit_scans FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'packing_staff', 'production')
    )
  );
