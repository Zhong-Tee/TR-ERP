ALTER TABLE public.or_order_items
  ADD COLUMN IF NOT EXISTS attachment_name TEXT;

COMMENT ON COLUMN public.or_order_items.attachment_name IS
  'Optional display label for file_attachment; UI falls back to File 1, File 2, ...';
