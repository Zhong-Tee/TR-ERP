-- The QT/PC list timed out inside can_manage_prebill_document (production log
-- 2026-10-28 03:35:14 UTC). Item SELECT policies also called the same helper
-- twice per item via their parent document. Resolve the unchanged owner scope
-- once per statement instead of looking up actor/owner for every document/item.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.prebill_accessible_owner_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT owner.id
  FROM public.us_users actor
  JOIN public.us_users owner ON (
    actor.role = 'superadmin'
    OR actor.id = owner.id
    OR (actor.role = 'sales-tr' AND owner.role = 'sales-tr')
  )
  WHERE actor.id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.prebill_accessible_owner_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prebill_accessible_owner_ids() TO authenticated;

-- Check the scope against the legacy helper for every actual account before
-- changing policies. Restore the caller's request context inside this transaction.
DO $$
DECLARE
  actor record;
  old_sub text := current_setting('request.jwt.claim.sub', true);
  old_claims text := current_setting('request.jwt.claims', true);
  legacy_ids uuid[];
  new_ids uuid[];
BEGIN
  FOR actor IN SELECT id FROM public.us_users UNION ALL SELECT NULL::uuid LOOP
    PERFORM set_config('request.jwt.claim.sub', coalesce(actor.id::text, ''), true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor.id, 'role', 'authenticated')::text, true);
    SELECT array_agg(id ORDER BY id) INTO legacy_ids
      FROM public.us_users WHERE public.can_manage_prebill_document(id);
    SELECT array_agg(id ORDER BY id) INTO new_ids
      FROM public.prebill_accessible_owner_ids() AS owners(id);
    IF legacy_ids IS DISTINCT FROM new_ids THEN
      RAISE EXCEPTION 'QT/PC owner scope differs from existing permissions; aborting';
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true);
  PERFORM set_config('request.jwt.claims', coalesce(old_claims, ''), true);
END;
$$;

ALTER POLICY prebill_documents_select ON public.or_prebill_documents
  USING (owner_id IN (SELECT public.prebill_accessible_owner_ids()));

ALTER POLICY prebill_documents_update ON public.or_prebill_documents
  USING (owner_id IN (SELECT public.prebill_accessible_owner_ids()))
  WITH CHECK (owner_id IN (SELECT public.prebill_accessible_owner_ids()));

ALTER POLICY prebill_items_select ON public.or_prebill_items
  USING (document_id IN (SELECT d.id FROM public.or_prebill_documents d));

-- The parent SELECT policy already enforces can_manage_prebill_document's
-- exact owner scope, including a valid actor and owner. Rechecking that helper
-- in this ALL policy was redundant, and made SELECT evaluate it twice.
ALTER POLICY prebill_items_write ON public.or_prebill_items
  USING (document_id IN (SELECT d.id FROM public.or_prebill_documents d))
  WITH CHECK (document_id IN (SELECT d.id FROM public.or_prebill_documents d));

COMMIT;
