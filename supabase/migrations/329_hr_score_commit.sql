-- =============================================================================
-- hr_score_commit_period — บันทึกผลคะแนนของพนักงาน 1 คน 1 เดือน แบบ atomic
--
-- ตรรกะคะแนนอยู่ฝั่ง TS (src/lib/workScore.ts) ฟังก์ชันนี้ทำแค่เขียนผลลง DB:
--   ลบเหตุการณ์อัตโนมัติเดิมของเดือนนั้น → ใส่ชุดใหม่ → อัปเดตสรุปรอบ → ล็อก (ถ้าสั่ง)
-- ทั้งหมดอยู่ใน statement เดียว คำนวณซ้ำกี่รอบก็ได้ผลเดิม
--
-- เหตุการณ์ที่ HR เพิ่มเอง (source='manual') ไม่ถูกลบ — ต้องลบทีละรายการเท่านั้น
--
-- IDEMPOTENT: safe to re-run
-- =============================================================================

CREATE OR REPLACE FUNCTION hr_score_commit_period(
  p_employee UUID,
  p_period DATE,
  p_category UUID,
  p_events JSONB,
  p_base NUMERIC,
  p_raw_deduction NUMERIC,
  p_total NUMERIC,
  p_lock BOOLEAN DEFAULT false
) RETURNS hr_score_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_period DATE := date_trunc('month', p_period)::DATE;
  v_next DATE := (date_trunc('month', p_period) + INTERVAL '1 month')::DATE;
  v_me UUID := hr_my_employee_id();
  v_row hr_score_periods;
BEGIN
  IF NOT hr_is_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์บันทึกคะแนน';
  END IF;

  IF hr_score_period_locked(p_employee, v_period) THEN
    RAISE EXCEPTION 'รอบเดือน % ปิดแล้ว บันทึกคะแนนซ้ำไม่ได้', to_char(v_period, 'YYYY-MM');
  END IF;

  DELETE FROM hr_score_events e
  WHERE e.employee_id = p_employee
    AND e.category_id = p_category
    AND e.source = 'auto'
    AND e.event_date >= v_period AND e.event_date < v_next;

  INSERT INTO hr_score_events
    (employee_id, event_date, category_id, rule_id, event_code, points, source, ref_table, ref_id, detail, created_by)
  SELECT
    p_employee,
    (ev ->> 'event_date')::DATE,
    p_category,
    NULLIF(ev ->> 'rule_id', '')::UUID,
    ev ->> 'event_code',
    (ev ->> 'points')::NUMERIC,
    'auto',
    NULLIF(ev ->> 'ref_table', ''),
    NULLIF(ev ->> 'ref_id', '')::UUID,
    COALESCE(ev -> 'detail', '{}'::JSONB),
    v_me
  FROM jsonb_array_elements(COALESCE(p_events, '[]'::JSONB)) AS ev;

  INSERT INTO hr_score_periods
    (employee_id, period, category_id, base_points, raw_deduction, total_points, status, locked_at, locked_by)
  VALUES (
    p_employee, v_period, p_category, p_base, p_raw_deduction, p_total,
    CASE WHEN p_lock THEN 'locked' ELSE 'open' END,
    CASE WHEN p_lock THEN now() END,
    CASE WHEN p_lock THEN v_me END
  )
  ON CONFLICT (employee_id, period, category_id) DO UPDATE SET
    base_points = EXCLUDED.base_points,
    raw_deduction = EXCLUDED.raw_deduction,
    total_points = EXCLUDED.total_points,
    status = EXCLUDED.status,
    locked_at = EXCLUDED.locked_at,
    locked_by = EXCLUDED.locked_by,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION hr_score_commit_period(UUID, DATE, UUID, JSONB, NUMERIC, NUMERIC, NUMERIC, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hr_score_commit_period(UUID, DATE, UUID, JSONB, NUMERIC, NUMERIC, NUMERIC, BOOLEAN) TO authenticated;

-- ยอมรับคำทักท้วง: คืนคะแนนด้วยเหตุการณ์ชดเชย (ไม่ลบของเดิม — ประวัติต้องอยู่ครบ)
CREATE OR REPLACE FUNCTION hr_score_accept_appeal(p_appeal UUID, p_note TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event hr_score_events;
  v_appeal hr_score_appeals;
BEGIN
  IF NOT hr_is_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ตัดสินคำทักท้วง';
  END IF;

  SELECT * INTO v_appeal FROM hr_score_appeals WHERE id = p_appeal;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบคำทักท้วง'; END IF;
  IF v_appeal.status <> 'pending' THEN RAISE EXCEPTION 'คำทักท้วงนี้ตัดสินไปแล้ว'; END IF;

  SELECT * INTO v_event FROM hr_score_events WHERE id = v_appeal.score_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ไม่พบเหตุการณ์ที่ทักท้วง'; END IF;

  INSERT INTO hr_score_events
    (employee_id, event_date, category_id, rule_id, event_code, points, source, ref_table, ref_id, detail, note, created_by)
  VALUES (
    v_event.employee_id, v_event.event_date, v_event.category_id, v_event.rule_id,
    v_event.event_code || '_reversed', -v_event.points, 'manual',
    'hr_score_appeals', p_appeal,
    jsonb_build_object('reversed_event_id', v_event.id, 'reversed_code', v_event.event_code),
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
