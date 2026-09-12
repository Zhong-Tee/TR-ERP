-- 189: Cutover การอ้างอิงใบงานด้วย work_order_id (UUID)
-- เป้าหมาย: ให้ work_order_name เป็นเลขที่แสดง (reuse ได้) และใช้ or_work_orders.id เป็นตัวตนจริง

-- 1) or_work_orders: ยอมให้ work_order_name ซ้ำได้ (remove UNIQUE)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'or_work_orders'
      AND c.contype = 'u'
      AND c.conname = 'or_work_orders_work_order_name_key'
  ) THEN
    ALTER TABLE or_work_orders DROP CONSTRAINT or_work_orders_work_order_name_key;
  END IF;
END;
$$;

-- 2) เพิ่มคอลัมน์ work_order_id + FK
ALTER TABLE or_orders
  ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES or_work_orders(id) ON DELETE SET NULL;

ALTER TABLE wms_orders
  ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES or_work_orders(id) ON DELETE SET NULL;

ALTER TABLE plan_jobs
  ADD COLUMN IF NOT EXISTS work_order_id UUID REFERENCES or_work_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_or_orders_work_order_id ON or_orders(work_order_id);
CREATE INDEX IF NOT EXISTS idx_wms_orders_work_order_id ON wms_orders(work_order_id);
CREATE INDEX IF NOT EXISTS idx_plan_jobs_work_order_id ON plan_jobs(work_order_id);

-- 3) Backfill จากชื่อเดิม (ช่วงก่อน cutover work_order_name ยัง unique)
UPDATE or_orders o
SET work_order_id = wo.id
FROM or_work_orders wo
WHERE o.work_order_id IS NULL
  AND o.work_order_name IS NOT NULL
  AND trim(both FROM o.work_order_name) <> ''
  AND trim(both FROM o.work_order_name) = trim(both FROM wo.work_order_name);

UPDATE wms_orders w
SET work_order_id = wo.id
FROM or_work_orders wo
WHERE w.work_order_id IS NULL
  AND w.order_id IS NOT NULL
  AND trim(both FROM w.order_id) <> ''
  AND trim(both FROM w.order_id) = trim(both FROM wo.work_order_name);

UPDATE plan_jobs pj
SET work_order_id = wo.id
FROM or_work_orders wo
WHERE pj.work_order_id IS NULL
  AND pj.name IS NOT NULL
  AND trim(both FROM pj.name) <> ''
  AND trim(both FROM pj.name) = trim(both FROM wo.work_order_name);

-- 4) Validation สำหรับ hard cutover (ถ้ายังมีแถวที่ควรมี work_order_id แต่เป็น NULL ให้ fail)
DO $$
DECLARE
  v_missing_orders INT;
  v_missing_wms    INT;
  v_missing_plan   INT;
BEGIN
  SELECT COUNT(*) INTO v_missing_orders
  FROM or_orders
  WHERE work_order_name IS NOT NULL
    AND trim(both FROM work_order_name) <> ''
    AND work_order_id IS NULL;

  SELECT COUNT(*) INTO v_missing_wms
  FROM wms_orders
  WHERE order_id IS NOT NULL
    AND trim(both FROM order_id) <> ''
    AND work_order_id IS NULL;

  SELECT COUNT(*) INTO v_missing_plan
  FROM plan_jobs
  WHERE name IS NOT NULL
    AND trim(both FROM name) <> ''
    AND work_order_id IS NULL;

  IF v_missing_orders > 0 THEN
    RAISE EXCEPTION 'Cutover failed: or_orders missing work_order_id = %', v_missing_orders;
  END IF;
  IF v_missing_wms > 0 THEN
    RAISE EXCEPTION 'Cutover failed: wms_orders missing work_order_id = %', v_missing_wms;
  END IF;
  IF v_missing_plan > 0 THEN
    RAISE EXCEPTION 'Cutover failed: plan_jobs missing work_order_id = %', v_missing_plan;
  END IF;
END;
$$;

