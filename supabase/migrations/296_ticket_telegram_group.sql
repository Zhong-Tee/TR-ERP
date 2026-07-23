ALTER TABLE hr_notification_settings
  ADD COLUMN IF NOT EXISTS ticket_group_chat_id TEXT;

UPDATE hr_notification_settings
SET ticket_group_chat_id = '-5379272031'
WHERE COALESCE(ticket_group_chat_id, '') = '';
