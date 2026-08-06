-- =============================================================================
-- คะแนนการปฏิบัติงาน (Work Score) — Phase 1: คะแนนวินัย (Discipline Score)
--
-- แนวคิด
--   · DB เก็บ "ข้อเท็จจริง" (เข้ากี่โมง ลาอนุมัติยัง) — กติกาคะแนนเป็น config ที่ HR แก้ได้
--   · ทุกคะแนนที่หักต้องชี้กลับได้ว่ามาจากบันทึกไหน (ref_table/ref_id) และเพราะอะไร (detail)
--   · หัวหน้า "รับรองเวลา" ผ่านตารางแยก — ไม่เปิด UPDATE ให้ hr_time_entries (กันแก้เวลาย้อนหลัง)
--   · เดือนที่ปิดรอบแล้ว (locked) ห้ามเขียนเหตุการณ์เพิ่ม/แก้/ลบ
--
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. hr_score_categories — หมวดคะแนน (Phase 1 = discipline) ───────────────
CREATE TABLE IF NOT EXISTS hr_score_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  -- คะแนนตั้งต้นต่อเดือน
  base_points NUMERIC(6,2) NOT NULL DEFAULT 100,
  -- พื้นของคะแนน — หักเกินแล้วหยุดที่ค่านี้ (ยอดหักจริงยังเก็บไว้ใน raw_deduction)
  min_points NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- น้ำหนักตอนรวมหลายหมวดเป็นคะแนนรวมของ Phase ถัดไป
  weight NUMERIC(5,2) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_points <= base_points)
);

-- ─── 2. hr_score_rules — กติกาแต่ละข้อ (HR แก้ได้จากหน้า ตั้งค่า) ────────────
CREATE TABLE IF NOT EXISTS hr_score_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES hr_score_categories(id) ON DELETE CASCADE,
  -- หัวข้อย่อยในหมวด: attendance | time_entry | leave | ot
  group_code TEXT NOT NULL,
  -- คีย์คงที่ที่ engine รู้จัก — ห้ามเปลี่ยนหลังใช้งานจริง (เหตุการณ์เก่าอ้างถึงอยู่)
  event_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- ติดลบ = หักคะแนน, บวก = ให้คะแนน, 0 = บันทึกไว้เฉย ๆ (เช่น หัวหน้ารับรองแล้วไม่หัก)
  points NUMERIC(6,2) NOT NULL DEFAULT 0,
  -- ช่วงเงื่อนไข (นาที) — ให้ HR ปรับช่วงได้เองโดยไม่ต้องแก้โค้ด ความหมายต่างกันตาม event_code
  threshold_min INT,
  threshold_max INT,
  -- เพดานหักรวมของกติกานี้ต่อเดือน (NULL = ไม่จำกัด) เก็บเป็นค่าบวก
  cap_per_month NUMERIC(6,2),
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cap_per_month IS NULL OR cap_per_month >= 0)
);

CREATE INDEX IF NOT EXISTS idx_hr_score_rules_category ON hr_score_rules(category_id, group_code, sort_order);

-- ─── 3. hr_time_certifications — หัวหน้ารับรองเวลาเข้า/ออก ───────────────────
CREATE TABLE IF NOT EXISTS hr_time_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('clock_in', 'clock_out')),
  -- เวลาที่หัวหน้าลงให้ใหม่
  certified_time TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  certified_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  certified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_hr_time_cert_date ON hr_time_certifications(work_date);
CREATE INDEX IF NOT EXISTS idx_hr_time_cert_employee_date ON hr_time_certifications(employee_id, work_date);

-- ─── 4. hr_score_periods — สรุปรายเดือน + สถานะปิดรอบ ───────────────────────
CREATE TABLE IF NOT EXISTS hr_score_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  -- วันที่ 1 ของเดือน
  period DATE NOT NULL,
  category_id UUID NOT NULL REFERENCES hr_score_categories(id) ON DELETE CASCADE,
  base_points NUMERIC(6,2) NOT NULL,
  -- ยอดหักจริง (ค่าบวก) ก่อนชนพื้น — ใช้เทียบความหนักระหว่างคน
  raw_deduction NUMERIC(8,2) NOT NULL DEFAULT 0,
  -- คะแนนสุทธิหลังชนพื้น min_points
  total_points NUMERIC(6,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, period, category_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_score_periods_period ON hr_score_periods(period);

-- ─── 5. hr_score_events — ledger เหตุการณ์ (เขียนตอนปิดรอบ / เพิ่มมือ) ───────
CREATE TABLE IF NOT EXISTS hr_score_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  category_id UUID NOT NULL REFERENCES hr_score_categories(id) ON DELETE CASCADE,
  rule_id UUID REFERENCES hr_score_rules(id) ON DELETE SET NULL,
  event_code TEXT NOT NULL,
  -- snapshot คะแนน ณ ตอนคำนวณ — ปรับกติกาทีหลังไม่ย้อนหลังไปแก้ของเก่า
  points NUMERIC(6,2) NOT NULL,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  -- โยงกลับบันทึกต้นทาง: hr_time_entries / hr_leave_requests / hr_ot_requests
  ref_table TEXT,
  ref_id UUID,
  -- เหตุผลแบบอ่านได้ เช่น {"late_min":12,"clock_in":"08:12"}
  detail JSONB NOT NULL DEFAULT '{}',
  note TEXT,
  created_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_score_events_employee_date ON hr_score_events(employee_id, event_date);
CREATE INDEX IF NOT EXISTS idx_hr_score_events_date ON hr_score_events(event_date);

-- เหตุการณ์อัตโนมัติห้ามซ้ำ — คำนวณ/ปิดรอบซ้ำแล้วต้องได้ผลเดิม
-- (เหตุการณ์ที่ HR เพิ่มเองซ้ำได้ เช่น หักซ้ำสองครั้งในวันเดียวคนละเหตุผล)
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_score_events_auto
  ON hr_score_events (employee_id, event_date, event_code)
  WHERE source = 'auto';

-- ─── 6. hr_score_appeals — พนักงานทักท้วงคะแนน ──────────────────────────────
CREATE TABLE IF NOT EXISTS hr_score_appeals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score_event_id UUID NOT NULL REFERENCES hr_score_events(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  reviewed_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_score_appeals_status ON hr_score_appeals(status);
CREATE INDEX IF NOT EXISTS idx_hr_score_appeals_employee ON hr_score_appeals(employee_id);

-- =============================================================================
-- Helper: ใครรับรองเวลาให้พนักงานคนนี้ได้
--   HR/admin ได้ทุกคน · หัวหน้าแผนก (hr_departments.manager_id) ได้เฉพาะลูกน้องในแผนก
--   หัวหน้ารับรองเวลาให้ตัวเองไม่ได้ (ต้องให้ HR ทำแทน)
-- =============================================================================
CREATE OR REPLACE FUNCTION hr_can_certify_time(p_employee_id UUID) RETURNS BOOLEAN AS $$
  SELECT hr_is_admin() OR EXISTS (
    SELECT 1
    FROM hr_employees e
    JOIN hr_departments d ON d.id = e.department_id
    WHERE e.id = p_employee_id
      AND d.manager_id = hr_my_employee_id()
      AND e.id <> hr_my_employee_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

-- รอบเดือนของพนักงานคนนี้ปิดไปแล้วหรือยัง
CREATE OR REPLACE FUNCTION hr_score_period_locked(p_employee_id UUID, p_date DATE) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_score_periods
    WHERE employee_id = p_employee_id
      AND period = date_trunc('month', p_date)::DATE
      AND status = 'locked'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

-- =============================================================================
-- Triggers
-- =============================================================================
DROP TRIGGER IF EXISTS trg_hr_score_categories_updated ON hr_score_categories;
CREATE TRIGGER trg_hr_score_categories_updated BEFORE UPDATE ON hr_score_categories
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_score_rules_updated ON hr_score_rules;
CREATE TRIGGER trg_hr_score_rules_updated BEFORE UPDATE ON hr_score_rules
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_time_certifications_updated ON hr_time_certifications;
CREATE TRIGGER trg_hr_time_certifications_updated BEFORE UPDATE ON hr_time_certifications
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_score_periods_updated ON hr_score_periods;
CREATE TRIGGER trg_hr_score_periods_updated BEFORE UPDATE ON hr_score_periods
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_score_appeals_updated ON hr_score_appeals;
CREATE TRIGGER trg_hr_score_appeals_updated BEFORE UPDATE ON hr_score_appeals
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- เดือนที่ปิดรอบแล้ว ห้ามแตะเหตุการณ์ — คะแนนที่ใช้ตัดสินโบนัสไปแล้วต้องไม่ขยับ
CREATE OR REPLACE FUNCTION hr_score_events_guard_locked() RETURNS TRIGGER AS $$
DECLARE
  v_employee UUID;
  v_date DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_employee := OLD.employee_id;
    v_date := OLD.event_date;
  ELSE
    v_employee := NEW.employee_id;
    v_date := NEW.event_date;
  END IF;

  IF hr_score_period_locked(v_employee, v_date) THEN
    RAISE EXCEPTION 'รอบเดือน % ของพนักงานคนนี้ปิดแล้ว แก้ไขคะแนนไม่ได้', to_char(v_date, 'YYYY-MM');
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_score_events_guard ON hr_score_events;
CREATE TRIGGER trg_hr_score_events_guard
  BEFORE INSERT OR UPDATE OR DELETE ON hr_score_events
  FOR EACH ROW EXECUTE FUNCTION hr_score_events_guard_locked();

-- ปิดรอบแล้วห้ามเปิดใหม่โดยไม่ตั้งใจ — ต้องเป็น superadmin เท่านั้น
CREATE OR REPLACE FUNCTION hr_score_periods_guard_unlock() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'locked' AND NEW.status = 'open' AND NOT hr_is_superadmin() THEN
    RAISE EXCEPTION 'เปิดรอบที่ปิดไปแล้วได้เฉพาะ superadmin';
  END IF;
  IF OLD.status = 'locked' AND NEW.status = 'locked'
     AND (NEW.total_points, NEW.raw_deduction) IS DISTINCT FROM (OLD.total_points, OLD.raw_deduction) THEN
    RAISE EXCEPTION 'รอบนี้ปิดแล้ว แก้คะแนนไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_score_periods_guard ON hr_score_periods;
CREATE TRIGGER trg_hr_score_periods_guard
  BEFORE UPDATE ON hr_score_periods
  FOR EACH ROW EXECUTE FUNCTION hr_score_periods_guard_unlock();

-- แจ้งเตือนพนักงานเมื่อผลอุทธรณ์ออก
CREATE OR REPLACE FUNCTION hr_score_appeal_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'score_appeal_pending', 'มีคำทักท้วงคะแนนรอตรวจสอบ', NEW.reason, '/hr/work-score', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin', 'admin', 'hr')
    LIMIT 5;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('accepted', 'rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'score_appeal_result',
      CASE WHEN NEW.status = 'accepted' THEN 'คำทักท้วงคะแนนได้รับการยอมรับ' ELSE 'คำทักท้วงคะแนนถูกปฏิเสธ' END,
      COALESCE(NEW.decision_note, ''),
      '/employee?tab=work-score',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_score_appeal_notify ON hr_score_appeals;
CREATE TRIGGER trg_hr_score_appeal_notify
  AFTER INSERT OR UPDATE ON hr_score_appeals
  FOR EACH ROW EXECUTE FUNCTION hr_score_appeal_notify();

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE hr_score_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_score_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_time_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_score_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_score_appeals ENABLE ROW LEVEL SECURITY;

-- หมวด/กติกา: ทุกคนที่ล็อกอินอ่านได้ (พนักงานต้องเห็นว่ากติกาคืออะไร), HR/admin จัดการ
DROP POLICY IF EXISTS "hr_score_categories_select" ON hr_score_categories;
DROP POLICY IF EXISTS "hr_score_categories_manage" ON hr_score_categories;
CREATE POLICY "hr_score_categories_select" ON hr_score_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_score_categories_manage" ON hr_score_categories FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

DROP POLICY IF EXISTS "hr_score_rules_select" ON hr_score_rules;
DROP POLICY IF EXISTS "hr_score_rules_manage" ON hr_score_rules;
CREATE POLICY "hr_score_rules_select" ON hr_score_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_score_rules_manage" ON hr_score_rules FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

-- ใบรับรองเวลา: เจ้าตัวอ่านของตัวเองได้ (ต้องเห็นป้ายในหน้าเวลาทำงาน), คนที่มีสิทธิ์รับรองจัดการได้
DROP POLICY IF EXISTS "hr_time_cert_select" ON hr_time_certifications;
DROP POLICY IF EXISTS "hr_time_cert_insert" ON hr_time_certifications;
DROP POLICY IF EXISTS "hr_time_cert_update" ON hr_time_certifications;
DROP POLICY IF EXISTS "hr_time_cert_delete" ON hr_time_certifications;
CREATE POLICY "hr_time_cert_select" ON hr_time_certifications FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id() OR hr_can_certify_time(employee_id));
CREATE POLICY "hr_time_cert_insert" ON hr_time_certifications FOR INSERT TO authenticated
  WITH CHECK (hr_can_certify_time(employee_id) AND NOT hr_score_period_locked(employee_id, work_date));
CREATE POLICY "hr_time_cert_update" ON hr_time_certifications FOR UPDATE TO authenticated
  USING (hr_can_certify_time(employee_id) AND NOT hr_score_period_locked(employee_id, work_date))
  WITH CHECK (hr_can_certify_time(employee_id));
CREATE POLICY "hr_time_cert_delete" ON hr_time_certifications FOR DELETE TO authenticated
  USING (hr_is_admin() AND NOT hr_score_period_locked(employee_id, work_date));

-- เหตุการณ์/สรุปรอบ: เจ้าตัวอ่านของตัวเองได้, HR/admin จัดการ
DROP POLICY IF EXISTS "hr_score_events_select" ON hr_score_events;
DROP POLICY IF EXISTS "hr_score_events_manage" ON hr_score_events;
CREATE POLICY "hr_score_events_select" ON hr_score_events FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_score_events_manage" ON hr_score_events FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

DROP POLICY IF EXISTS "hr_score_periods_select" ON hr_score_periods;
DROP POLICY IF EXISTS "hr_score_periods_manage" ON hr_score_periods;
CREATE POLICY "hr_score_periods_select" ON hr_score_periods FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_score_periods_manage" ON hr_score_periods FOR ALL TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

-- อุทธรณ์: พนักงานยื่นของตัวเองได้เฉพาะเหตุการณ์ของตัวเองในรอบที่ยังไม่ปิด, HR/admin ตัดสิน
DROP POLICY IF EXISTS "hr_score_appeals_select" ON hr_score_appeals;
DROP POLICY IF EXISTS "hr_score_appeals_insert" ON hr_score_appeals;
DROP POLICY IF EXISTS "hr_score_appeals_update" ON hr_score_appeals;
CREATE POLICY "hr_score_appeals_select" ON hr_score_appeals FOR SELECT TO authenticated
  USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_score_appeals_insert" ON hr_score_appeals FOR INSERT TO authenticated
  WITH CHECK (
    employee_id = hr_my_employee_id()
    AND EXISTS (
      SELECT 1 FROM hr_score_events ev
      WHERE ev.id = score_event_id
        AND ev.employee_id = hr_my_employee_id()
        AND NOT hr_score_period_locked(ev.employee_id, ev.event_date)
    )
  );
CREATE POLICY "hr_score_appeals_update" ON hr_score_appeals FOR UPDATE TO authenticated
  USING (hr_is_admin()) WITH CHECK (hr_is_admin());

-- =============================================================================
-- Seed: Phase 1 — คะแนนวินัย
-- =============================================================================
INSERT INTO hr_score_categories (code, name, description, base_points, min_points, weight, sort_order)
VALUES ('discipline', 'คะแนนวินัย', 'การมาทำงาน การลงเวลา การลา และ OT', 100, 0, 1, 1)
ON CONFLICT (code) DO NOTHING;

INSERT INTO hr_score_rules (category_id, group_code, event_code, name, points, threshold_min, threshold_max, sort_order)
SELECT c.id, v.group_code, v.event_code, v.name, v.points, v.threshold_min, v.threshold_max, v.sort_order
FROM hr_score_categories c
CROSS JOIN (VALUES
  -- 1. การมาทำงาน — threshold_min/max = ช่วงนาทีที่สาย (นับหลังหักเวลาผ่อนผัน)
  ('attendance', 'late_1_15',            'มาสาย 1–15 นาที',                              -1::NUMERIC,  1::INT,   15::INT,  10::INT),
  ('attendance', 'late_16_30',           'มาสาย 16–30 นาที',                             -2::NUMERIC, 16::INT,   30::INT,  20::INT),
  ('attendance', 'late_over_30',         'มาสายเกิน 30 นาที',                            -4::NUMERIC, 31::INT, NULL::INT,  30::INT),
  -- threshold_min = นาทีที่ออกก่อนเวลาแล้วเริ่มนับว่าผิด (ผ่อนผัน)
  ('attendance', 'early_leave',          'กลับก่อนเวลา',                                 -4::NUMERIC,  1::INT, NULL::INT,  40::INT),

  -- 2. การลงเวลา
  ('time_entry', 'missing_in_certified', 'ไม่มีเวลาเข้า แต่หัวหน้ารับรองเวลาได้',          0::NUMERIC, NULL::INT, NULL::INT, 10::INT),
  -- threshold_min = นาทีขั้นต่ำระหว่างเวลาเข้างานถึงเวลาที่กดออก จึงจะเชื่อว่ามาทำงานจริง
  -- (ต่ำกว่านี้ = แวะมากดออกเฉย ๆ → นับเป็นขาดงาน)
  ('time_entry', 'missing_in_unproven',  'ไม่มีเวลาเข้า และพิสูจน์เวลาไม่ได้',            -5::NUMERIC, 240::INT, NULL::INT, 20::INT),
  ('time_entry', 'missing_out_certified','ไม่มีเวลาออก แต่หัวหน้ารับรองเวลาได้',           0::NUMERIC, NULL::INT, NULL::INT, 30::INT),
  ('time_entry', 'missing_out_unproven', 'ไม่มีเวลาออก และพิสูจน์เวลาไม่ได้',             -5::NUMERIC, NULL::INT, NULL::INT, 40::INT),

  -- 3. การลา
  ('leave',      'leave_approved',       'ลาถูกต้องตามระเบียบ (อนุมัติแล้ว)',              0::NUMERIC, NULL::INT, NULL::INT, 10::INT),
  ('leave',      'leave_late_notice',    'แจ้งลาหลังเวลาเริ่มงาน',                        -2::NUMERIC, NULL::INT, NULL::INT, 20::INT),
  ('leave',      'absent_pending_leave', 'ไม่มาทำงาน ทั้งที่การลายังไม่อนุมัติ',          -10::NUMERIC, NULL::INT, NULL::INT, 30::INT),
  ('leave',      'absent',               'ขาดงาน',                                       -20::NUMERIC, NULL::INT, NULL::INT, 40::INT),

  -- 4. OT
  ('ot',         'ot_late_request',      'ลืมขอ OT ก่อนเริ่มทำ',                          -2::NUMERIC, NULL::INT, NULL::INT, 10::INT),
  ('ot',         'ot_unapproved',        'ทำ OT โดยไม่ได้รับอนุมัติ',                     -3::NUMERIC, NULL::INT, NULL::INT, 20::INT)
) AS v(group_code, event_code, name, points, threshold_min, threshold_max, sort_order)
WHERE c.code = 'discipline'
ON CONFLICT (event_code) DO NOTHING;

-- =============================================================================
-- Realtime — หน้า HR เห็นคะแนนขยับทันทีเมื่อหัวหน้ารับรองเวลา
-- =============================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_time_certifications;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_score_appeals;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
