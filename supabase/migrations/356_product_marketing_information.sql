BEGIN;

CREATE TABLE IF NOT EXISTS public.pr_product_marketing_info (
  product_id UUID PRIMARY KEY REFERENCES public.pr_products(id) ON DELETE CASCADE,
  highlights TEXT,
  launch_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.pr_product_marketing_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.pr_products(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('photo', 'advertisement', 'document')),
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_product_marketing_assets_product
  ON public.pr_product_marketing_assets(product_id, uploaded_at DESC);

ALTER TABLE public.pr_product_marketing_info ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pr_product_marketing_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_marketing_info_authenticated ON public.pr_product_marketing_info;
CREATE POLICY product_marketing_info_authenticated ON public.pr_product_marketing_info
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS product_marketing_assets_authenticated ON public.pr_product_marketing_assets;
CREATE POLICY product_marketing_assets_authenticated ON public.pr_product_marketing_assets
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-marketing', 'product-marketing', true, 20971520,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS product_marketing_storage_select ON storage.objects;
CREATE POLICY product_marketing_storage_select ON storage.objects
  FOR SELECT USING (bucket_id = 'product-marketing');
DROP POLICY IF EXISTS product_marketing_storage_insert ON storage.objects;
CREATE POLICY product_marketing_storage_insert ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'product-marketing');
DROP POLICY IF EXISTS product_marketing_storage_delete ON storage.objects;
CREATE POLICY product_marketing_storage_delete ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'product-marketing');

COMMIT;
