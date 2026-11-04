-- =============================================================================
-- คำทักท้วงคะแนน: เลิกผูกกับแถวใน hr_score_events
--
-- ปัญหาเดิม: hr_score_appeals.score_event_id บังคับให้ HR ต้อง "บันทึกคะแนน"
-- ลง ledger ก่อน พนักงานจึงจะทักท้วงได้ แต่คะแนนของเดือนที่ยังไม่ปิดรอบเป็นการ
-- คำนวณสด (ยังไม่มีแถวใน DB) → ไม่มีจังหวะไหนเลยที่กดทักท้วงได้จริง
--
-- แก้เป็น: ผูกกับ (employee_id + event_date + event_code) ซึ่งคำนวณสดก็มีครบ
-- score_event_id เหลือไว้เป็นข้อมูลอ้างอิงถ้ามีแถวจริงอยู่แล้ว
--
-- IDEMPOTENT: safe to re-run
-- =============================================================================

ALTER TABLE hr_score_appeals ADD COLUMN IF NOT EXISTS event_date DATE;
ALTER TABLE hr_score_appeals ADD COLUMN IF NOT EXISTS event_code TEXT;
-- คะแนนที่ถูกหัก ณ ตอนยื่น (ค่าติดลบ) — ใช้คำนวณยอดคืนตอนยอมรับ
ALTER TABLE hr_score_appeals ADD COLUMN IF NOT EXISTS points NUMERIC(6,2);
ALTER TABLE hr_score_appeals ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES hr_score_categories(id) ON DELETE CASCADE;

-- เติมข้อมูลให้คำทักท้วงเก่า (ถ้ามี) ก่อนบังคับ NOT NULL
UPDATE hr_score_appeals a
SET event_date = COALESCE(a.event_date, ev.event_date),
    event_code = COALESCE(a.event_code, ev.event_code),
    points = COALESCE(a.points, ev.points),
    category_id = COALESCE(a.category_id, ev.category_id)
FROM hr_score_events ev
WHERE ev.id = a.score_event_id
  AND (a.event_date IS NULL OR a.event_code IS NULL OR a.category_id IS NULL);

-- คำทักท้วงที่หา event ต้นทางไม่เจอแล้ว (ถูกลบ) — ทิ้ง เพราะอ้างอิงอะไรไม่ได้
DELETE FROM hr_score_appeals WHERE event_date IS NULL OR event_code IS NULL OR category_id IS NULL;

ALTER TABLE hr_score_appeals ALTER COLUMN event_date SET NOT NULL;
ALTER TABLE hr_score_appeals ALTER COLUMN event_code SET NOT NULL;
ALTER TABLE hr_score_appeals ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE hr_score_appeals ALTER COLUMN points SET DEFAULT 0;
UPDATE hr_score_appeals SET points = 0 WHERE points IS NULL;
ALTER TABLE hr_score_appeals ALTER COLUMN points SET NOT NULL;

-- ไม่ต้องมีแถวใน ledger อีกต่อไป
ALTER TABLE hr_score_appeals ALTER COLUMN score_event_id DROP NOT NULL;
ALTER TABLE hr_score_appeals DROP CONSTRAINT IF EXISTS hr_score_appeals_score_event_id_fkey;
ALTER TABLE hr_score_appeals
  ADD CONSTRAINT hr_score_appeals_score_event_id_fkey
  FOREIGN KEY (score_event_id) REFERENCES hr_score_events(id) ON DELETE SET NULL;

-- ทักท้วงเหตุการณ์เดิมซ้ำไม่ได้ (ยกเว้นที่ถูกปฏิเสธไปแล้ว ยื่นใหม่พร้อมหลักฐานได้)
DROP INDEX IF EXISTS uq_hr_score_appeals_event;
CREATE UNIQUE INDEX uq_hr_score_appeals_event
  ON hr_score_appeals (employee_id, event_date, event_code)
  WHERE status <> 'rejected';

CREATE INDEX IF NOT EXISTS idx_hr_score_appeals_event_date ON hr_score_appeals(event_date);

-- ─── RLS: ยื่นได้โดยไม่ต้องมีแถวใน hr_score_events ──────────────────────────
DROP POLICY IF EXISTS "hr_score_appeals_insert" ON hr_score_appeals;
CREATE POLICY "hr_score_appeals_insert" ON hr_score_appeals FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = hr_my_employee_id()
    AND hr_score_can_appeal_date(event_date)
    AND NOT hr_score_period_locked(employee_id, event_date)
    -- ทักท้วงได้เฉพาะรายการที่หักคะแนน
    AND points < 0
  );

-- ─── ยอมรับคำทักท้วง: สร้างเหตุการณ์ชดเชยจากข้อมูลในคำทักท้วงเอง ────────────
DROP FUNCTION IF EXISTS hr_score_accept_appeal(UUID, TEXT);

CREATE OR REPLACE FUNCTION hr_score_accept_appeal(p_appeal UUID, p_note TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appeal hr_score_appeals;
BEGIN
  IF NOT hr_is_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตัดสินคำทักท้วง';
  END IF;

  SELECT * INTO v_appeal FROM hr_score_appeals WHERE id = p_appeal;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำทักท้วง'; END IF;
  IF v_appeal.status <> 'pending' THEN RAISE EXCEPTION 'คำทักท้วงนี้ตัดสินไปแล้ว'; END IF;

  -- เหตุการณ์ชดเชย: คะแนนตรงข้ามกับที่ถูกหัก · ไม่ลบของเดิม ประวัติต้องอยู่ครบ
  -- source='manual' จึงไม่ถูกลบตอนคำนวณคะแนนใหม่
  INSERT INTO hr_score_events
    (employee_id, event_date, category_id, event_code, points, source, ref_table, ref_id, detail, note, created_by)
  VALUES (
    v_appeal.employee_id,
    v_appeal.event_date,
    v_appeal.category_id,
    v_appeal.event_code || '_reversed',
    -v_appeal.points,
    'manual',
    'hr_score_appeals',
    p_appeal,
    jsonb_build_object('reversed_code', v_appeal.event_code, 'appeal_id', p_appeal),
    COALESCE(p_note, 'ยอมรับคำทักท้วง'),
    hr_my_employee_id()
  );

  UPDATE hr_score_appeals
  SET status = 'accepted', reviewed_by = hr_my_employee_id(), reviewed_at = now(), decision_note = p_note
  WHERE id = p_appeal;
END;
$$;

REVOKE ALL ON FUNCTION hr_score_accept_appeal(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_score_accept_appeal(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
