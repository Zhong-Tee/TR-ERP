-- plan_jobs RLS: superadmin, admin, production, store (FOR ALL)
-- Backfill: or_work_orders ที่ยังไม่มี plan_jobs (ยกเว้น status ยกเลิก)

DROP POLICY IF EXISTS "plan_jobs_write" ON plan_jobs;

CREATE POLICY "plan_jobs_write"
  ON plan_jobs FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'production', 'store')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM us_users
      WHERE id = auth.uid()
        AND role IN ('superadmin', 'admin', 'production', 'store')
    )
  );

WITH mx AS (
  SELECT COALESCE(max(order_index), -1) AS m FROM plan_jobs
),
candidates AS (
  SELECT
    wo.id,
    wo.work_order_name,
    wo.order_count,
    wo.created_at,
    row_number() OVER (ORDER BY wo.created_at) AS rn
  FROM or_work_orders wo
  WHERE trim(both FROM coalesce(wo.work_order_name, '')) <> ''
    AND coalesce(wo.status, '') <> 'ยกเลิก'
    AND NOT EXISTS (
      SELECT 1 FROM plan_jobs pj WHERE pj.work_order_id = wo.id
    )
)
INSERT INTO plan_jobs (
  id,
  date,
  name,
  work_order_id,
  cut,
  qty,
  tracks,
  line_assignments,
  manual_plan_starts,
  locked_plans,
  order_index,
  is_production_voided
)
SELECT
  'J' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
  to_char(timezone('Asia/Bangkok', c.created_at), 'YYYY-MM-DD'),
  c.work_order_name,
  c.id,
  to_char(timezone('Asia/Bangkok', c.created_at), 'HH24:MI'),
  jsonb_build_object(
    'STAMP', 0,
    'STK', 0,
    'CTT', 0,
    'LASER', 0,
    'TUBE', 0,
    'ETC', 0,
    'PACK', COALESCE(c.order_count, 0)
  ),
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  '{}'::jsonb,
  mx.m + c.rn,
  false
FROM candidates c
CROSS JOIN mx;

COMMENT ON POLICY "plan_jobs_write" ON plan_jobs IS
  'เขียน plan_jobs ได้เฉพาะ superadmin, admin, production, store (223)';
