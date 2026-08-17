-- Track which immutable Knowledge version is currently in use.

ALTER TABLE public.kb_items
  ADD COLUMN IF NOT EXISTS active_version_id UUID;

ALTER TABLE public.kb_items
  DROP CONSTRAINT IF EXISTS kb_items_active_version_id_fkey;
ALTER TABLE public.kb_items
  ADD CONSTRAINT kb_items_active_version_id_fkey
  FOREIGN KEY (active_version_id) REFERENCES public.kb_item_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_kb_items_active_version ON public.kb_items(active_version_id);

CREATE OR REPLACE FUNCTION public.kb_create_item_version(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  item_row public.kb_items%ROWTYPE;
  next_version INTEGER;
  new_version_id UUID;
BEGIN
  SELECT * INTO item_row FROM public.kb_items WHERE id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Knowledge item not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_item_id::text));
  SELECT COALESCE(MAX(version_no), 0) + 1 INTO next_version
  FROM public.kb_item_versions WHERE item_id = p_item_id;

  INSERT INTO public.kb_item_versions (
    item_id, version_no, title, description, content, category_id, machine_id,
    department_id, access_level, tags, allowed_roles, saved_by
  ) VALUES (
    item_row.id, next_version, item_row.title, item_row.description, item_row.content,
    item_row.category_id, item_row.machine_id, item_row.department_id,
    item_row.access_level, item_row.tags,
    ARRAY(SELECT role FROM public.kb_item_roles WHERE item_id = p_item_id ORDER BY role),
    item_row.updated_by
  ) RETURNING id INTO new_version_id;

  UPDATE public.kb_items SET active_version_id = new_version_id WHERE id = p_item_id;
  RETURN next_version;
END;
$$;

-- Existing records use their latest recorded version initially.
UPDATE public.kb_items item
SET active_version_id = (
  SELECT version.id
  FROM public.kb_item_versions version
  WHERE version.item_id = item.id
  ORDER BY version.version_no DESC
  LIMIT 1
)
WHERE item.active_version_id IS NULL;
