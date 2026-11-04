-- Add an optional web link to order chat messages. Existing rows remain valid.

ALTER TABLE public.or_order_chat_logs
  ADD COLUMN IF NOT EXISTS link_url text;

COMMENT ON COLUMN public.or_order_chat_logs.link_url IS
  'Optional HTTP(S) URL displayed as a link button beside the chat message';

ALTER TABLE public.or_order_chat_logs
  DROP CONSTRAINT IF EXISTS or_order_chat_logs_link_url_check;

ALTER TABLE public.or_order_chat_logs
  ADD CONSTRAINT or_order_chat_logs_link_url_check
  CHECK (
    link_url IS NULL
    OR (
      char_length(link_url) <= 2048
      AND link_url ~* '^https?://'
    )
  );
