-- Allow production to update only the attachment link metadata shown in the
-- order detail screen. The function does not expose any other order-item field.

CREATE OR REPLACE FUNCTION public.rpc_update_order_item_attachment(
  p_item_id uuid,
  p_file_attachment text DEFAULT NULL,
  p_attachment_name text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
  v_link text := NULLIF(btrim(p_file_attachment), '');
  v_name text := NULLIF(btrim(p_attachment_name), '');
BEGIN
  SELECT u.role
    INTO v_role
  FROM public.us_users AS u
  WHERE u.id = auth.uid()
    AND u.is_active IS TRUE;

  IF v_role IS DISTINCT FROM 'production' THEN
    RAISE EXCEPTION 'Only production can use this attachment-only update';
  END IF;

  IF v_link IS NOT NULL AND (
    char_length(v_link) > 2048
    OR v_link !~* '^https?://[^[:space:]]+$'
  ) THEN
    RAISE EXCEPTION 'Invalid attachment URL';
  END IF;

  IF v_name IS NOT NULL AND char_length(v_name) > 255 THEN
    RAISE EXCEPTION 'Attachment name is too long';
  END IF;

  UPDATE public.or_order_items
  SET file_attachment = v_link,
      attachment_name = v_name
  WHERE id = p_item_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order item not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_update_order_item_attachment(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_update_order_item_attachment(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_item_attachment(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_order_item_attachment(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.rpc_update_order_item_attachment(uuid, text, text) IS
  'Production-only narrow update for or_order_items.file_attachment and attachment_name';
