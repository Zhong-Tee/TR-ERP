-- Add is_hidden flag to or_order_chat_logs for soft-hide (not delete)
ALTER TABLE or_order_chat_logs
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for filtering hidden messages
CREATE INDEX IF NOT EXISTS idx_order_chat_logs_is_hidden
  ON or_order_chat_logs(is_hidden);
