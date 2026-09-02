-- Ensure every table that drives Plan/TopBar counters is present in Realtime.
DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'or_orders',
    'or_work_orders',
    'or_issues',
    'or_issue_messages',
    'or_order_chat_logs',
    'or_issue_reads',
    'or_order_chat_reads'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = v_table
       ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END;
$$;

-- UPDATE/DELETE events remain identifiable through RLS and reconnects.
ALTER TABLE public.or_orders REPLICA IDENTITY FULL;
ALTER TABLE public.or_work_orders REPLICA IDENTITY FULL;
ALTER TABLE public.or_issues REPLICA IDENTITY FULL;
ALTER TABLE public.or_issue_messages REPLICA IDENTITY FULL;
ALTER TABLE public.or_order_chat_logs REPLICA IDENTITY FULL;
ALTER TABLE public.or_issue_reads REPLICA IDENTITY FULL;
ALTER TABLE public.or_order_chat_reads REPLICA IDENTITY FULL;

NOTIFY pgrst, 'reload schema';
