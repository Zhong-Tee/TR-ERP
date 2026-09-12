-- Speed up the consolidated Confirm board query.
-- Only pipeline rows that can appear on the board are included in the index.
CREATE INDEX IF NOT EXISTS idx_or_orders_confirm_board_status_created_at
  ON public.or_orders (status, created_at)
  WHERE channel_code = 'PUMP' OR requires_confirm_design = true;

-- Speed up unread chat aggregation and per-order chat lookups.
CREATE INDEX IF NOT EXISTS idx_order_chat_logs_visible_order_created_at
  ON public.or_order_chat_logs (order_id, created_at)
  WHERE COALESCE(is_hidden, false) = false;
