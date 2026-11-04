-- Make Mobile "auditor" access a real database capability, not only a UI mode.
-- Mobile auditors may see and update only audits assigned to their own user id.

BEGIN;

CREATE OR REPLACE FUNCTION public.current_user_can_audit()
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
      AND (
        role = 'auditor'
        OR COALESCE(mobile_access, '[]'::jsonb) ? 'auditor'
      )
  );
$$;

REVOKE ALL ON FUNCTION public.current_user_can_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can_audit() TO authenticated;

DROP POLICY IF EXISTS "Mobile auditors can view assigned audits" ON public.inv_audits;
CREATE POLICY "Mobile auditors can view assigned audits"
  ON public.inv_audits FOR SELECT TO authenticated
  USING (
    public.current_user_can_audit()
    AND auth.uid() = ANY(COALESCE(assigned_to, ARRAY[]::uuid[]))
  );

DROP POLICY IF EXISTS "Mobile auditors can update assigned audits" ON public.inv_audits;
CREATE POLICY "Mobile auditors can update assigned audits"
  ON public.inv_audits FOR UPDATE TO authenticated
  USING (
    public.current_user_can_audit()
    AND auth.uid() = ANY(COALESCE(assigned_to, ARRAY[]::uuid[]))
  )
  WITH CHECK (
    public.current_user_can_audit()
    AND auth.uid() = ANY(COALESCE(assigned_to, ARRAY[]::uuid[]))
  );

DROP POLICY IF EXISTS "Mobile auditors can view assigned audit items" ON public.inv_audit_items;
CREATE POLICY "Mobile auditors can view assigned audit items"
  ON public.inv_audit_items FOR SELECT TO authenticated
  USING (
    public.current_user_can_audit()
    AND EXISTS (
      SELECT 1
      FROM public.inv_audits audit
      WHERE audit.id = inv_audit_items.audit_id
        AND auth.uid() = ANY(COALESCE(audit.assigned_to, ARRAY[]::uuid[]))
    )
  );

DROP POLICY IF EXISTS "Mobile auditors can update assigned audit items" ON public.inv_audit_items;
CREATE POLICY "Mobile auditors can update assigned audit items"
  ON public.inv_audit_items FOR UPDATE TO authenticated
  USING (
    public.current_user_can_audit()
    AND EXISTS (
      SELECT 1
      FROM public.inv_audits audit
      WHERE audit.id = inv_audit_items.audit_id
        AND auth.uid() = ANY(COALESCE(audit.assigned_to, ARRAY[]::uuid[]))
    )
  )
  WITH CHECK (
    public.current_user_can_audit()
    AND EXISTS (
      SELECT 1
      FROM public.inv_audits audit
      WHERE audit.id = inv_audit_items.audit_id
        AND auth.uid() = ANY(COALESCE(audit.assigned_to, ARRAY[]::uuid[]))
    )
  );

DROP POLICY IF EXISTS "Mobile auditors can insert assigned count logs" ON public.inv_audit_count_logs;
CREATE POLICY "Mobile auditors can insert assigned count logs"
  ON public.inv_audit_count_logs FOR INSERT TO authenticated
  WITH CHECK (
    public.current_user_can_audit()
    AND counted_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.inv_audit_items item
      JOIN public.inv_audits audit ON audit.id = item.audit_id
      WHERE item.id = inv_audit_count_logs.audit_item_id
        AND auth.uid() = ANY(COALESCE(audit.assigned_to, ARRAY[]::uuid[]))
    )
  );

COMMIT;
