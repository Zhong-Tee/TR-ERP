-- Knowledge visibility: general = permitted users, restricted = selected roles,
-- private = superadmin only. Writes remain admin/superadmin only.

CREATE OR REPLACE FUNCTION public.kb_current_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.us_users
  WHERE id = auth.uid() AND COALESCE(is_active, true) = true
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.kb_is_knowledge_manager()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(public.kb_current_role() IN ('superadmin', 'admin'), false); $$;

CREATE OR REPLACE FUNCTION public.kb_can_read_item(p_item_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.kb_items item
    WHERE item.id = p_item_id
      AND CASE
        WHEN public.kb_current_role() = 'superadmin' THEN true
        WHEN item.access_level = 'private' THEN false
        WHEN item.access_level = 'general' THEN public.kb_current_role() IS NOT NULL
        WHEN item.access_level = 'restricted' THEN EXISTS (
          SELECT 1 FROM public.kb_item_roles permission
          WHERE permission.item_id = item.id
            AND permission.role = public.kb_current_role()
        )
        ELSE false
      END
  );
$$;

GRANT EXECUTE ON FUNCTION public.kb_current_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kb_is_knowledge_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.kb_can_read_item(UUID) TO authenticated;

-- Replace broad table policies with read-by-access and manager-write policies.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_categories', 'kb_items', 'kb_files', 'kb_item_roles', 'kb_item_versions'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_superadmin_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_manager_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_manager_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_manager_delete', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS kb_categories_read ON public.kb_categories;
CREATE POLICY kb_categories_read ON public.kb_categories FOR SELECT TO authenticated USING (public.kb_current_role() IS NOT NULL);
CREATE POLICY kb_categories_manager_insert ON public.kb_categories FOR INSERT TO authenticated WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_categories_manager_update ON public.kb_categories FOR UPDATE TO authenticated USING (public.kb_is_knowledge_manager()) WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_categories_manager_delete ON public.kb_categories FOR DELETE TO authenticated USING (public.kb_is_knowledge_manager());

DROP POLICY IF EXISTS kb_items_read ON public.kb_items;
CREATE POLICY kb_items_read ON public.kb_items FOR SELECT TO authenticated USING (public.kb_can_read_item(id));
CREATE POLICY kb_items_manager_insert ON public.kb_items FOR INSERT TO authenticated
WITH CHECK (public.kb_is_knowledge_manager() AND (access_level <> 'private' OR public.kb_current_role() = 'superadmin'));
CREATE POLICY kb_items_manager_update ON public.kb_items FOR UPDATE TO authenticated
USING (public.kb_is_knowledge_manager())
WITH CHECK (public.kb_is_knowledge_manager() AND (access_level <> 'private' OR public.kb_current_role() = 'superadmin'));
CREATE POLICY kb_items_manager_delete ON public.kb_items FOR DELETE TO authenticated USING (public.kb_is_knowledge_manager());

DROP POLICY IF EXISTS kb_files_read ON public.kb_files;
CREATE POLICY kb_files_read ON public.kb_files FOR SELECT TO authenticated USING (public.kb_can_read_item(item_id));
CREATE POLICY kb_files_manager_insert ON public.kb_files FOR INSERT TO authenticated WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_files_manager_update ON public.kb_files FOR UPDATE TO authenticated USING (public.kb_is_knowledge_manager()) WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_files_manager_delete ON public.kb_files FOR DELETE TO authenticated USING (public.kb_is_knowledge_manager());

DROP POLICY IF EXISTS kb_item_roles_read ON public.kb_item_roles;
CREATE POLICY kb_item_roles_read ON public.kb_item_roles FOR SELECT TO authenticated
USING (public.kb_is_knowledge_manager() OR role = public.kb_current_role());
CREATE POLICY kb_item_roles_manager_insert ON public.kb_item_roles FOR INSERT TO authenticated WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_item_roles_manager_update ON public.kb_item_roles FOR UPDATE TO authenticated USING (public.kb_is_knowledge_manager()) WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_item_roles_manager_delete ON public.kb_item_roles FOR DELETE TO authenticated USING (public.kb_is_knowledge_manager());

DROP POLICY IF EXISTS kb_item_versions_superadmin_all ON public.kb_item_versions;
DROP POLICY IF EXISTS kb_item_versions_read ON public.kb_item_versions;
CREATE POLICY kb_item_versions_read ON public.kb_item_versions FOR SELECT TO authenticated USING (public.kb_can_read_item(item_id));
CREATE POLICY kb_item_versions_manager_insert ON public.kb_item_versions FOR INSERT TO authenticated WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_item_versions_manager_update ON public.kb_item_versions FOR UPDATE TO authenticated USING (public.kb_is_knowledge_manager()) WITH CHECK (public.kb_is_knowledge_manager());
CREATE POLICY kb_item_versions_manager_delete ON public.kb_item_versions FOR DELETE TO authenticated USING (public.kb_is_knowledge_manager());

-- Storage follows the parent Knowledge item access.
DROP POLICY IF EXISTS "kb_storage_superadmin_select" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_select" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_can_read_item((split_part(name, '/', 1))::UUID));
DROP POLICY IF EXISTS "kb_storage_superadmin_insert" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'knowledge-hub' AND public.kb_is_knowledge_manager());
DROP POLICY IF EXISTS "kb_storage_superadmin_update" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_update" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_is_knowledge_manager())
WITH CHECK (bucket_id = 'knowledge-hub' AND public.kb_is_knowledge_manager());
DROP POLICY IF EXISTS "kb_storage_superadmin_delete" ON storage.objects;
CREATE POLICY "kb_storage_superadmin_delete" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'knowledge-hub' AND public.kb_is_knowledge_manager());

-- Enable the menu for desktop roles; Settings can still turn a role off later.
INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
SELECT role, 'knowledge-hub', 'Knowledge Hub', true
FROM unnest(ARRAY['superadmin','admin','sales-tr','qc_order','sales-pump','qc_staff','packing_staff','account','store','production','hr']) role
ON CONFLICT (role, menu_key) DO NOTHING;
