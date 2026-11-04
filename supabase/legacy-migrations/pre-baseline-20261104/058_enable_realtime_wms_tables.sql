-- Enable Supabase Realtime for WMS-related tables
-- จำเป็นสำหรับให้ตัวเลข badge และข้อมูลอัปเดตแบบเรียลไทม์

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE wms_orders;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE wms_notifications;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE wms_requisitions;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_work_orders;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_issues;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE or_issue_messages;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;
