-- Knowledge Hub MVP: simple searchable company knowledge and private files.

CREATE SEQUENCE IF NOT EXISTS public.kb_knowledge_code_seq START 1;

CREATE TABLE IF NOT EXISTS public.kb_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kb_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  description TEXT,
  content TEXT,
  category_id UUID REFERENCES public.kb_categories(id) ON DELETE SET NULL,
  machine_id UUID REFERENCES public.pr_machinery_machines(id) ON DELETE SET NULL,
  access_level TEXT NOT NULL DEFAULT 'general'
    CHECK (access_level IN ('general', 'restricted', 'private')),
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  updated_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kb_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES public.kb_items(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  file_extension TEXT,
  file_size BIGINT NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  description TEXT,
  searchable_text TEXT,
  uploaded_by UUID NOT NULL DEFAULT auth.uid() REFERENCES public.us_users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.kb_item_roles (
  item_id UUID NOT NULL REFERENCES public.kb_items(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (item_id, role)
);

CREATE OR REPLACE FUNCTION public.kb_set_item_defaults()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.knowledge_code IS NULL OR btrim(NEW.knowledge_code) = '' THEN
    NEW.knowledge_code := 'KB-' || lpad(nextval('public.kb_knowledge_code_seq')::text, 6, '0');
  END IF;
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_items_defaults ON public.kb_items;
CREATE TRIGGER trg_kb_items_defaults
BEFORE INSERT OR UPDATE ON public.kb_items
FOR EACH ROW EXECUTE FUNCTION public.kb_set_item_defaults();

CREATE OR REPLACE FUNCTION public.kb_touch_category()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_categories_updated_at ON public.kb_categories;
CREATE TRIGGER trg_kb_categories_updated_at
BEFORE UPDATE ON public.kb_categories
FOR EACH ROW EXECUTE FUNCTION public.kb_touch_category();

CREATE INDEX IF NOT EXISTS idx_kb_items_updated_at ON public.kb_items(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_items_category ON public.kb_items(category_id);
CREATE INDEX IF NOT EXISTS idx_kb_items_machine ON public.kb_items(machine_id);
CREATE INDEX IF NOT EXISTS idx_kb_items_access ON public.kb_items(access_level);
CREATE INDEX IF NOT EXISTS idx_kb_items_tags ON public.kb_items USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_kb_files_item ON public.kb_files(item_id);
CREATE INDEX IF NOT EXISTS idx_kb_item_roles_role ON public.kb_item_roles(role);

INSERT INTO public.kb_categories (name, description, sort_order) VALUES
  ('ความรู้ทั่วไป', 'ความรู้และข้อมูลทั่วไปของบริษัท', 10),
  ('คู่มือการทำงาน', 'คู่มือและขั้นตอนการทำงาน', 20),
  ('เอกสารสำคัญ', 'เอกสารสำคัญที่ต้องควบคุมสิทธิ์', 30),
  ('นโยบายบริษัท', 'นโยบายและข้อกำหนดของบริษัท', 40),
  ('เครื่องจักร', 'คู่มือและข้อมูลเกี่ยวกับเครื่องจักร', 50),
  ('โปรแกรมเครื่องจักร', 'โปรแกรมและไฟล์สำหรับเครื่องจักร', 60),
  ('Production JSON', 'ไฟล์ JSON สำหรับรันผลิต', 70),
  ('Script / Configuration', 'สคริปต์และไฟล์ตั้งค่าระบบ', 80),
  ('แบบฟอร์ม', 'แบบฟอร์มสำหรับใช้งานภายใน', 90),
  ('อื่นๆ', 'ข้อมูลที่ไม่อยู่ในหมวดอื่น', 100)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.kb_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_item_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.kb_is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role = 'superadmin' AND COALESCE(is_active, true) = true
  );
$$;

REVOKE ALL ON FUNCTION public.kb_is_superadmin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kb_is_superadmin() TO authenticated;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_categories', 'kb_items', 'kb_files', 'kb_item_roles'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_superadmin_all', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.kb_is_superadmin()) WITH CHECK (public.kb_is_superadmin())',
      t || '_superadmin_all', t
    );
  END LOOP;
END $$;

INSERT INTO storage.buckets (id, name, public)
VALUES ('knowledge-hub', 'knowledge-hub', false)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "kb_storage_superadmin_select" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_select" ON storage.objects
FOR SELECT TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_is_superadmin());

DROP POLICY IF EXISTS "kb_storage_superadmin_insert" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_insert" ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'knowledge-hub' AND public.kb_is_superadmin());

DROP POLICY IF EXISTS "kb_storage_superadmin_update" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_update" ON storage.objects
FOR UPDATE TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_is_superadmin())
WITH CHECK (bucket_id = 'knowledge-hub' AND public.kb_is_superadmin());

DROP POLICY IF EXISTS "kb_storage_superadmin_delete" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_delete" ON storage.objects
FOR DELETE TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_is_superadmin());

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES ('superadmin', 'knowledge-hub', 'Knowledge Hub', true)
ON CONFLICT (role, menu_key) DO UPDATE
SET menu_name = EXCLUDED.menu_name, has_access = true, updated_at = now();

