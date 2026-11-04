-- Add source_scope column to or_issue_messages to track which menu the message was sent from
ALTER TABLE or_issue_messages
  ADD COLUMN IF NOT EXISTS source_scope TEXT DEFAULT 'orders' CHECK (source_scope IN ('orders', 'plan'));
