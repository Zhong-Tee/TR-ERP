INSERT INTO storage.buckets (id, name, public)
VALUES ('hr-warning-certificates', 'hr-warning-certificates', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "hr_warning_cert_files_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_warning_cert_files_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_warning_cert_files_update" ON storage.objects;
DROP POLICY IF EXISTS "hr_warning_cert_files_delete" ON storage.objects;

CREATE POLICY "hr_warning_cert_files_select" ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'hr-warning-certificates'
  AND (
    public.hr_is_admin()
    OR (storage.foldername(name))[1] = public.hr_my_employee_id()::text
  )
);

CREATE POLICY "hr_warning_cert_files_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'hr-warning-certificates' AND public.hr_is_admin());

CREATE POLICY "hr_warning_cert_files_update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'hr-warning-certificates' AND public.hr_is_admin())
WITH CHECK (bucket_id = 'hr-warning-certificates' AND public.hr_is_admin());

CREATE POLICY "hr_warning_cert_files_delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'hr-warning-certificates' AND public.hr_is_admin());
