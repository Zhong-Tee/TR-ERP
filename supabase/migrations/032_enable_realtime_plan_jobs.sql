-- Enable Realtime for plan_jobs so แผนผลิต Dashboard (Master Plan)
-- updates in real-time when เริ่ม/เสร็จ/ล้าง from หน้าแผนก (คิวงาน).
-- Run: supabase db push (or already enabled via Dashboard → Database → Replication).

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE plan_jobs;
EXCEPTION
  WHEN OTHERS THEN NULL; -- e.g. already in publication
END $$;
