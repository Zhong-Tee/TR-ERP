-- =============================================================================
-- 325: คำร้อง/ข้อเสนอแนะจากพนักงาน
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.hr_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_user UUID NOT NULL DEFAULT auth.uid(),
  employee_id UUID REFERENCES public.hr_employees(id) ON DELETE SET NULL,
  problem_title TEXT NOT NULL,
  time_lost TEXT NOT NULL,
  details TEXT NOT NULL,
  suggested_solution TEXT NOT NULL,
  time_reallocation TEXT NOT NULL,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'submitted',
  hr_note TEXT,
  received_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  updated_by UUID REFERENCES public.us_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hr_requests_status_check CHECK (status IN (
    'submitted', 'accepted', 'more_info', 'approved_waiting',
    'in_progress', 'resolved', 'cannot_resolve', 'rejected'
  ))
);

CREATE INDEX IF NOT EXISTS idx_hr_requests_creator ON public.hr_requests(created_by_user, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hr_requests_status ON public.hr_requests(status, created_at DESC);

ALTER TABLE public.hr_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_requests_select ON public.hr_requests;
CREATE POLICY hr_requests_select ON public.hr_requests FOR SELECT TO authenticated
  USING (created_by_user = auth.uid() OR (SELECT public.hr_is_admin()));

DROP POLICY IF EXISTS hr_requests_insert ON public.hr_requests;
CREATE POLICY hr_requests_insert ON public.hr_requests FOR INSERT TO authenticated
  WITH CHECK (created_by_user = auth.uid());

DROP POLICY IF EXISTS hr_requests_update_admin ON public.hr_requests;
CREATE POLICY hr_requests_update_admin ON public.hr_requests FOR UPDATE TO authenticated
  USING ((SELECT public.hr_is_admin()))
  WITH CHECK ((SELECT public.hr_is_admin()));

CREATE OR REPLACE FUNCTION public.hr_requests_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_hr_requests_updated_at ON public.hr_requests;
CREATE TRIGGER trg_hr_requests_updated_at BEFORE UPDATE ON public.hr_requests
  FOR EACH ROW EXECUTE FUNCTION public.hr_requests_set_updated_at();

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.hr_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ไฟล์แนบเก็บในโฟลเดอร์ <auth.uid()>/<request-id>/...
INSERT INTO storage.buckets (id, name, public)
VALUES ('hr-requests', 'hr-requests', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS hr_requests_files_select ON storage.objects;
CREATE POLICY hr_requests_files_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'hr-requests'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR (SELECT public.hr_is_admin()))
  );

DROP POLICY IF EXISTS hr_requests_files_insert ON storage.objects;
CREATE POLICY hr_requests_files_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'hr-requests' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS hr_requests_files_delete ON storage.objects;
CREATE POLICY hr_requests_files_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'hr-requests'
    AND ((storage.foldername(name))[1] = auth.uid()::text OR (SELECT public.hr_is_admin()))
  );

-- สิทธิ์เมนู HR: ให้ 4 role เห็นแถบคำร้องตั้งแต่รัน migration
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('superadmin', 'hr-requests', 'HR · คำร้อง', true),
  ('admin',      'hr-requests', 'HR · คำร้อง', true),
  ('account',    'hr-requests', 'HR · คำร้อง', true),
  ('hr',         'hr-requests', 'HR · คำร้อง', true)
ON CONFLICT (role, menu_key) DO UPDATE SET menu_name = EXCLUDED.menu_name, has_access = true;
