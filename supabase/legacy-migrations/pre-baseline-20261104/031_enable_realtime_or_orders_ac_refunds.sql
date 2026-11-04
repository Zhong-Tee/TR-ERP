-- Enable Realtime for or_orders and ac_refunds so sidebar menu counts
-- (รอตรวจคำสั่งซื้อ, บัญชี) update immediately on INSERT/UPDATE/DELETE.
-- Run: supabase db push (or apply via Dashboard → Database → Replication).

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_orders;
EXCEPTION
  WHEN OTHERS THEN NULL; -- e.g. already in publication
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE ac_refunds;
EXCEPTION
  WHEN OTHERS THEN NULL; -- e.g. already in publication
END $$;
