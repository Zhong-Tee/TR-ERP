-- =============================================================================
-- 150: HR Asset Registry (ทะเบียนทรัพย์สิน)
-- =============================================================================

BEGIN;

-- ─── Table: hr_assets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT,
  department_id UUID REFERENCES hr_departments(id) ON DELETE SET NULL,
  location TEXT,
  purchase_date DATE,
  purchase_cost NUMERIC(14,2),
  current_value NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'active',
  assigned_employee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  images JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT hr_assets_status_check CHECK (status IN ('active', 'maintenance', 'retired', 'lost'))
);

CREATE INDEX IF NOT EXISTS idx_hr_assets_department ON hr_assets(department_id);
CREATE INDEX IF NOT EXISTS idx_hr_assets_assigned_employee ON hr_assets(assigned_employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_assets_status ON hr_assets(status);
CREATE INDEX IF NOT EXISTS idx_hr_assets_name ON hr_assets(name);

ALTER TABLE hr_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hr_assets_all" ON hr_assets;
CREATE POLICY "hr_assets_all" ON hr_assets FOR ALL TO authenticated USING (hr_is_admin());

DROP TRIGGER IF EXISTS trg_hr_assets_updated ON hr_assets;
CREATE TRIGGER trg_hr_assets_updated BEFORE UPDATE ON hr_assets FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- ─── Storage bucket for asset images ────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public) VALUES
  ('hr-assets', 'hr-assets', false)
ON CONFLICT (id) DO NOTHING;

-- Expand existing HR private storage policies to include hr-assets bucket.
DROP POLICY IF EXISTS "hr_private_buckets_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_private_buckets_delete" ON storage.objects;

CREATE POLICY "hr_private_buckets_select" ON storage.objects FOR SELECT
  USING (
    bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes','hr-assets')
    AND (SELECT hr_is_admin() OR auth.uid() IS NOT NULL)
  );
CREATE POLICY "hr_private_buckets_insert" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes','hr-assets')
    AND (SELECT hr_is_admin())
  );
CREATE POLICY "hr_private_buckets_delete" ON storage.objects FOR DELETE
  USING (
    bucket_id IN ('hr-documents','hr-contracts','hr-company-docs','hr-attendance','hr-resumes','hr-assets')
    AND (SELECT hr_is_admin())
  );

-- ─── Default menu access: new submenu hr-assets ─────────────────────────────
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('superadmin', 'hr-assets', 'ทะเบียนทรัพย์สิน', true),
  ('admin', 'hr-assets', 'ทะเบียนทรัพย์สิน', true),
  ('sales-tr', 'hr-assets', 'ทะเบียนทรัพย์สิน', true),
  ('hr', 'hr-assets', 'ทะเบียนทรัพย์สิน', true)
ON CONFLICT (role, menu_key) DO NOTHING;

COMMIT;
