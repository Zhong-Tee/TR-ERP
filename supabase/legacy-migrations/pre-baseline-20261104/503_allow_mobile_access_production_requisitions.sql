-- Allow users whose account has the production mobile mode enabled to create
-- WMS requisitions, regardless of their primary role. This is intentionally
-- narrower than the legacy production_mb FOR ALL policy: mobile access does
-- not grant approval, rejection, or arbitrary update permissions.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_has_mobile_access(p_mode text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND is_active = true
      AND COALESCE(mobile_access, '[]'::jsonb) ? p_mode
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_has_mobile_access(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_has_mobile_access(text) TO authenticated;

DROP POLICY IF EXISTS "Production mobile access can read requisition topics"
  ON public.wms_requisition_topics;
CREATE POLICY "Production mobile access can read requisition topics"
  ON public.wms_requisition_topics FOR SELECT
  TO authenticated
  USING (public.current_user_has_mobile_access('production_mb'));

-- The client counts today's requisitions before generating REQ-YYYYMMDD-NNN,
-- so it needs visibility of all headers to avoid duplicate requisition IDs.
DROP POLICY IF EXISTS "Production mobile access can read requisitions"
  ON public.wms_requisitions;
CREATE POLICY "Production mobile access can read requisitions"
  ON public.wms_requisitions FOR SELECT
  TO authenticated
  USING (public.current_user_has_mobile_access('production_mb'));

DROP POLICY IF EXISTS "Production mobile access can create requisitions"
  ON public.wms_requisitions;
CREATE POLICY "Production mobile access can create requisitions"
  ON public.wms_requisitions FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_user_has_mobile_access('production_mb')
    AND created_by = auth.uid()
    AND status = 'pending'
    AND approved_by IS NULL
    AND approved_at IS NULL
  );

-- The client removes a newly-created pending header if inserting its items or
-- uploading evidence fails. Cascading deletion removes any inserted items.
DROP POLICY IF EXISTS "Production mobile access can delete own pending requisitions"
  ON public.wms_requisitions;
CREATE POLICY "Production mobile access can delete own pending requisitions"
  ON public.wms_requisitions FOR DELETE
  TO authenticated
  USING (
    public.current_user_has_mobile_access('production_mb')
    AND created_by = auth.uid()
    AND status = 'pending'
  );

DROP POLICY IF EXISTS "Production mobile access can read own requisition items"
  ON public.wms_requisition_items;
CREATE POLICY "Production mobile access can read own requisition items"
  ON public.wms_requisition_items FOR SELECT
  TO authenticated
  USING (
    public.current_user_has_mobile_access('production_mb')
    AND EXISTS (
      SELECT 1
      FROM public.wms_requisitions requisition
      WHERE requisition.requisition_id = wms_requisition_items.requisition_id
        AND requisition.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Production mobile access can create own requisition items"
  ON public.wms_requisition_items;
CREATE POLICY "Production mobile access can create own requisition items"
  ON public.wms_requisition_items FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_user_has_mobile_access('production_mb')
    AND EXISTS (
      SELECT 1
      FROM public.wms_requisitions requisition
      WHERE requisition.requisition_id = wms_requisition_items.requisition_id
        AND requisition.created_by = auth.uid()
        AND requisition.status = 'pending'
    )
  );

COMMIT;
