BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('tax-evidence','tax-evidence',false,10485760,ARRAY['application/pdf','image/png','image/jpeg']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY tax_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
 bucket_id='tax-evidence' AND EXISTS(SELECT 1 FROM public.us_users WHERE id=auth.uid() AND role IN ('account','superadmin'))
 AND EXISTS(SELECT 1 FROM public.or_orders WHERE id::text=(storage.foldername(name))[1] AND billing_details @> '{"withholding_requested":true}')
);
CREATE POLICY tax_evidence_read ON storage.objects FOR SELECT TO authenticated USING (
 bucket_id='tax-evidence' AND EXISTS(SELECT 1 FROM public.or_orders WHERE id::text=(storage.foldername(name))[1])
);
COMMIT;
