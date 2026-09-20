-- Keep existing QT/PC installations in sync with the current item form.
-- Migration 576 originally created this table with CREATE TABLE IF NOT EXISTS;
-- installations that already had the table did not receive fields added later.

ALTER TABLE public.or_prebill_items
  ADD COLUMN IF NOT EXISTS is_detail_row BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS parent_item_id UUID,
  ADD COLUMN IF NOT EXISTS line_pattern TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS field_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'or_prebill_items_parent_item_fk'
      AND conrelid = 'public.or_prebill_items'::regclass
  ) THEN
    ALTER TABLE public.or_prebill_items
      ADD CONSTRAINT or_prebill_items_parent_item_fk
      FOREIGN KEY (parent_item_id)
      REFERENCES public.or_prebill_items(id)
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_prebill_items_parent_item
  ON public.or_prebill_items(parent_item_id)
  WHERE parent_item_id IS NOT NULL;

-- Ask PostgREST to refresh immediately so newly added fields can be inserted
-- without waiting for its automatic schema-cache refresh.
NOTIFY pgrst, 'reload schema';
