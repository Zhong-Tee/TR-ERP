-- Allow only superadmin, admin and store to manage roll-material pairings.
-- Existing SELECT policies continue to allow authenticated read access.

DROP POLICY IF EXISTS "rmc_write" ON roll_material_categories;
CREATE POLICY "rmc_write" ON roll_material_categories
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ));

DROP POLICY IF EXISTS "rmcfg_write" ON roll_material_configs;
CREATE POLICY "rmcfg_write" ON roll_material_configs
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ));

DROP POLICY IF EXISTS "rmcr_insert" ON roll_material_config_rms;
DROP POLICY IF EXISTS "rmcr_update" ON roll_material_config_rms;
DROP POLICY IF EXISTS "rmcr_delete" ON roll_material_config_rms;
DROP POLICY IF EXISTS "rmcr_write" ON roll_material_config_rms;
CREATE POLICY "rmcr_write" ON roll_material_config_rms
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'store')
  ));
