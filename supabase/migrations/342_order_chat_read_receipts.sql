-- Realtime read receipts for Confirm Order Chat (✓ sent / ✓✓ read).
BEGIN;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_order_chat_reads;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%already%member%' THEN RAISE; END IF;
END $$;

COMMIT;
