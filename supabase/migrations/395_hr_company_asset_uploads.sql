-- PNG logo/signature uploads for HR company settings.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('hr-company-assets', 'hr-company-assets', TRUE, 5242880, ARRAY['image/png'])
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS hr_company_assets_select ON storage.objects;
CREATE POLICY hr_company_assets_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'hr-company-assets');
DROP POLICY IF EXISTS hr_company_assets_insert ON storage.objects;
CREATE POLICY hr_company_assets_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'hr-company-assets' AND public.hr_company_manage_allowed());
DROP POLICY IF EXISTS hr_company_assets_update ON storage.objects;
CREATE POLICY hr_company_assets_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'hr-company-assets' AND public.hr_company_manage_allowed())
  WITH CHECK (bucket_id = 'hr-company-assets' AND public.hr_company_manage_allowed());
DROP POLICY IF EXISTS hr_company_assets_delete ON storage.objects;
CREATE POLICY hr_company_assets_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'hr-company-assets' AND public.hr_company_manage_allowed());
