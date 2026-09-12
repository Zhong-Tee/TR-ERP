-- -------------------------------------------------------------------
-- Compatibility alias for legacy table name used by older clients:
--   pic_packing_unit_scans  -> pk_packing_unit_scans
--
-- Some deployments/clients still reference `pic_*`. Provide an updatable
-- view so reads/writes go to the canonical table `pk_packing_unit_scans`.
-- -------------------------------------------------------------------

-- If the canonical table hasn't been created in this environment yet,
-- create it here to keep packing scans functional.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.pk_packing_unit_scans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.or_orders(id) ON DELETE CASCADE,
  unit_uid TEXT NOT NULL,
  scanned_by UUID REFERENCES public.us_users(id),
  scanned_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'scanned',
  UNIQUE(order_id, unit_uid)
);

CREATE INDEX IF NOT EXISTS idx_pk_packing_unit_scans_order_id
  ON public.pk_packing_unit_scans(order_id);

CREATE INDEX IF NOT EXISTS idx_pk_packing_unit_scans_unit_uid
  ON public.pk_packing_unit_scans(unit_uid);

ALTER TABLE public.pk_packing_unit_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Packing staff can manage unit scans" ON public.pk_packing_unit_scans;
CREATE POLICY "Packing staff can manage unit scans"
  ON public.pk_packing_unit_scans FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.us_users
      WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'packing_staff')
    )
  );

DROP POLICY IF EXISTS "Authenticated users can read unit scans" ON public.pk_packing_unit_scans;
CREATE POLICY "Authenticated users can read unit scans"
  ON public.pk_packing_unit_scans FOR SELECT
  USING (auth.role() = 'authenticated');

DROP VIEW IF EXISTS public.pic_packing_unit_scans;

-- SECURITY INVOKER ensures RLS/privileges are evaluated as the caller,
-- not as the view owner (important for Supabase).
CREATE VIEW public.pic_packing_unit_scans
WITH (security_invoker = true) AS
SELECT *
FROM public.pk_packing_unit_scans;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pic_packing_unit_scans TO anon, authenticated;

