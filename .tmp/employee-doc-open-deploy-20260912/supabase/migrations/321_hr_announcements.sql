-- =============================================================================
-- ระบบประกาศ (Announcements)
--   - superadmin / admin / account เป็นผู้สร้างประกาศ
--   - ประกาศใหม่ = รออนุมัติ จนกว่าผู้อนุมัติ (ตั้งค่าโดย superadmin) จะกดครบทุกคน
--   - เมื่ออนุมัติครบ → เผยแพร่ให้พนักงานกลุ่มเป้าหมายอ่านและกดรับทราบ
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── Helper: สิทธิ์จัดการประกาศ ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION hr_can_manage_announcements() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users
    WHERE id = auth.uid() AND role IN ('superadmin','admin','account')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

CREATE OR REPLACE FUNCTION hr_is_superadmin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid() AND role = 'superadmin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

-- ─── 1. ประเภทประกาศ ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_announcement_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ประเภทเริ่มต้น (แก้ไข/ลบ/เพิ่มเองได้ในหน้าตั้งค่า HR)
INSERT INTO hr_announcement_categories (name, description, sort_order) VALUES
  ('ประกาศทั่วไป', 'ข่าวสารทั่วไปของบริษัท', 1),
  ('นโยบายบริษัท', 'นโยบาย ระเบียบ ข้อบังคับที่พนักงานต้องรับทราบ', 2),
  ('วันหยุด/ปฏิทินบริษัท', 'ประกาศวันหยุดประจำปี วันหยุดชดเชย', 3),
  ('สวัสดิการ', 'สวัสดิการ โบนัส ประกัน สิทธิประโยชน์พนักงาน', 4),
  ('ความปลอดภัย', 'ความปลอดภัยในการทำงาน อุบัติเหตุ การป้องกัน', 5),
  ('กิจกรรม/อบรม', 'กิจกรรมบริษัท การอบรม สัมมนา', 6),
  ('การเปลี่ยนแปลงองค์กร', 'โครงสร้างองค์กร การแต่งตั้ง โยกย้าย', 7),
  ('ประกาศด่วน', 'เรื่องเร่งด่วนที่ต้องรับทราบทันที', 8)
ON CONFLICT (name) DO NOTHING;

-- ─── 2. ประกาศ ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES hr_announcement_categories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  attachment_urls TEXT[] NOT NULL DEFAULT '{}',
  is_pinned BOOLEAN NOT NULL DEFAULT false,
  target_all_departments BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_by_user UUID,
  published_at TIMESTAMPTZ,
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE hr_announcements DROP CONSTRAINT IF EXISTS hr_announcements_status_check;
ALTER TABLE hr_announcements ADD CONSTRAINT hr_announcements_status_check
  CHECK (status IN ('pending','published','rejected'));

CREATE INDEX IF NOT EXISTS idx_hr_announcements_status ON hr_announcements(status);
CREATE INDEX IF NOT EXISTS idx_hr_announcements_published ON hr_announcements(published_at DESC);

-- แผนกเป้าหมาย (ใช้เมื่อ target_all_departments = false)
CREATE TABLE IF NOT EXISTS hr_announcement_departments (
  announcement_id UUID NOT NULL REFERENCES hr_announcements(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES hr_departments(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, department_id)
);

-- ─── 3. ผู้อนุมัติ (ตั้งค่าโดย superadmin) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_announcement_approvers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL UNIQUE REFERENCES hr_employees(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- การอนุมัติของแต่ละประกาศ (snapshot ผู้อนุมัติ ณ เวลาที่สร้าง)
CREATE TABLE IF NOT EXISTS hr_announcement_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL REFERENCES hr_announcements(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  acted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (announcement_id, employee_id)
);

ALTER TABLE hr_announcement_approvals DROP CONSTRAINT IF EXISTS hr_announcement_approvals_status_check;
ALTER TABLE hr_announcement_approvals ADD CONSTRAINT hr_announcement_approvals_status_check
  CHECK (status IN ('pending','approved','rejected'));

CREATE INDEX IF NOT EXISTS idx_hr_ann_approvals_employee ON hr_announcement_approvals(employee_id, status);

-- ─── 4. การรับทราบของพนักงาน ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_announcement_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id UUID NOT NULL REFERENCES hr_announcements(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (announcement_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_ann_reads_employee ON hr_announcement_reads(employee_id);

-- =============================================================================
-- Trigger: สร้างรายการอนุมัติอัตโนมัติ + เผยแพร่เมื่ออนุมัติครบ
-- =============================================================================

/** ประกาศนี้อนุมัติครบหรือยัง → อัปเดตสถานะประกาศให้ตรงกับผลอนุมัติ */
CREATE OR REPLACE FUNCTION hr_announcement_sync_status(p_announcement_id UUID) RETURNS VOID AS $$
DECLARE
  v_total INT;
  v_approved INT;
  v_rejected INT;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE status = 'approved'), count(*) FILTER (WHERE status = 'rejected')
    INTO v_total, v_approved, v_rejected
  FROM hr_announcement_approvals WHERE announcement_id = p_announcement_id;

  IF v_rejected > 0 THEN
    UPDATE hr_announcements SET status = 'rejected', published_at = NULL
    WHERE id = p_announcement_id AND status <> 'rejected';
  ELSIF v_total > 0 AND v_approved = v_total THEN
    UPDATE hr_announcements SET status = 'published', published_at = coalesce(published_at, now())
    WHERE id = p_announcement_id AND status <> 'published';
  ELSE
    UPDATE hr_announcements SET status = 'pending', published_at = NULL
    WHERE id = p_announcement_id AND status <> 'pending';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

/** ประกาศใหม่ → สร้างรายการรออนุมัติจากผู้อนุมัติที่เปิดใช้งาน (ไม่มีผู้อนุมัติ = เผยแพร่ทันที) */
CREATE OR REPLACE FUNCTION hr_announcement_after_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO hr_announcement_approvals (announcement_id, employee_id)
  SELECT NEW.id, a.employee_id FROM hr_announcement_approvers a WHERE a.is_active
  ON CONFLICT (announcement_id, employee_id) DO NOTHING;

  PERFORM hr_announcement_sync_status(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_announcement_after_insert ON hr_announcements;
CREATE TRIGGER trg_hr_announcement_after_insert
  AFTER INSERT ON hr_announcements
  FOR EACH ROW EXECUTE FUNCTION hr_announcement_after_insert();

/** แก้ไขเนื้อหาประกาศ → รีเซ็ตการอนุมัติทั้งหมด ให้ผู้อนุมัติกดใหม่ */
CREATE OR REPLACE FUNCTION hr_announcement_after_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.attachment_urls IS DISTINCT FROM OLD.attachment_urls
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.target_all_departments IS DISTINCT FROM OLD.target_all_departments THEN
    UPDATE hr_announcement_approvals
      SET status = 'pending', acted_at = NULL, note = NULL
      WHERE announcement_id = NEW.id AND status <> 'pending';
    UPDATE hr_announcements SET reject_reason = NULL WHERE id = NEW.id AND reject_reason IS NOT NULL;
    PERFORM hr_announcement_sync_status(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_announcement_after_update ON hr_announcements;
CREATE TRIGGER trg_hr_announcement_after_update
  AFTER UPDATE ON hr_announcements
  FOR EACH ROW EXECUTE FUNCTION hr_announcement_after_update();

/** ผู้อนุมัติกดอนุมัติ/ปฏิเสธ → อัปเดตสถานะประกาศ */
CREATE OR REPLACE FUNCTION hr_announcement_approval_after_update() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'rejected' AND coalesce(NEW.note, '') <> '' THEN
      UPDATE hr_announcements SET reject_reason = NEW.note WHERE id = NEW.announcement_id;
    END IF;
    PERFORM hr_announcement_sync_status(NEW.announcement_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_announcement_approval_after_update ON hr_announcement_approvals;
CREATE TRIGGER trg_hr_announcement_approval_after_update
  AFTER UPDATE ON hr_announcement_approvals
  FOR EACH ROW EXECUTE FUNCTION hr_announcement_approval_after_update();

DROP TRIGGER IF EXISTS trg_hr_announcements_updated ON hr_announcements;
CREATE TRIGGER trg_hr_announcements_updated
  BEFORE UPDATE ON hr_announcements
  FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE hr_announcement_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_announcement_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_announcement_approvers ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_announcement_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_announcement_reads ENABLE ROW LEVEL SECURITY;

/** พนักงานคนนี้เป็นกลุ่มเป้าหมายของประกาศหรือไม่ */
CREATE OR REPLACE FUNCTION hr_announcement_targets_me(p_announcement_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM hr_announcements a
    JOIN hr_employees e ON e.id = hr_my_employee_id()
    WHERE a.id = p_announcement_id
      AND (
        a.target_all_departments
        OR EXISTS (
          SELECT 1 FROM hr_announcement_departments d
          WHERE d.announcement_id = a.id AND d.department_id = e.department_id
        )
      )
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

-- ประเภทประกาศ: ทุกคนอ่านได้ / จัดการได้เฉพาะผู้มีสิทธิ์
DROP POLICY IF EXISTS "hr_ann_categories_select" ON hr_announcement_categories;
DROP POLICY IF EXISTS "hr_ann_categories_write" ON hr_announcement_categories;
CREATE POLICY "hr_ann_categories_select" ON hr_announcement_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_ann_categories_write" ON hr_announcement_categories FOR ALL TO authenticated
  USING (hr_can_manage_announcements()) WITH CHECK (hr_can_manage_announcements());

-- ประกาศ: ผู้จัดการเห็นทุกใบ / ผู้อนุมัติเห็นใบที่ต้องอนุมัติ / พนักงานเห็นเฉพาะที่เผยแพร่และเป็นกลุ่มเป้าหมาย
DROP POLICY IF EXISTS "hr_announcements_select" ON hr_announcements;
DROP POLICY IF EXISTS "hr_announcements_insert" ON hr_announcements;
DROP POLICY IF EXISTS "hr_announcements_update" ON hr_announcements;
DROP POLICY IF EXISTS "hr_announcements_delete" ON hr_announcements;
CREATE POLICY "hr_announcements_select" ON hr_announcements FOR SELECT TO authenticated USING (
  hr_can_manage_announcements()
  OR EXISTS (
    SELECT 1 FROM hr_announcement_approvals ap
    WHERE ap.announcement_id = hr_announcements.id AND ap.employee_id = hr_my_employee_id()
  )
  OR (status = 'published' AND hr_announcement_targets_me(hr_announcements.id))
);
CREATE POLICY "hr_announcements_insert" ON hr_announcements FOR INSERT TO authenticated
  WITH CHECK (hr_can_manage_announcements());
CREATE POLICY "hr_announcements_update" ON hr_announcements FOR UPDATE TO authenticated
  USING (hr_can_manage_announcements()) WITH CHECK (hr_can_manage_announcements());
CREATE POLICY "hr_announcements_delete" ON hr_announcements FOR DELETE TO authenticated
  USING (hr_can_manage_announcements());

-- แผนกเป้าหมาย: อ่านได้ทุกคน (ใช้ประกอบการแสดงผล) / แก้ไขเฉพาะผู้มีสิทธิ์
DROP POLICY IF EXISTS "hr_ann_departments_select" ON hr_announcement_departments;
DROP POLICY IF EXISTS "hr_ann_departments_write" ON hr_announcement_departments;
CREATE POLICY "hr_ann_departments_select" ON hr_announcement_departments FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_ann_departments_write" ON hr_announcement_departments FOR ALL TO authenticated
  USING (hr_can_manage_announcements()) WITH CHECK (hr_can_manage_announcements());

-- ผู้อนุมัติ: ทุกคนอ่านได้ / ตั้งค่าได้เฉพาะ superadmin
DROP POLICY IF EXISTS "hr_ann_approvers_select" ON hr_announcement_approvers;
DROP POLICY IF EXISTS "hr_ann_approvers_write" ON hr_announcement_approvers;
CREATE POLICY "hr_ann_approvers_select" ON hr_announcement_approvers FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_ann_approvers_write" ON hr_announcement_approvers FOR ALL TO authenticated
  USING (hr_is_superadmin()) WITH CHECK (hr_is_superadmin());

-- การอนุมัติ: อ่านได้ทุกคน (โชว์ว่าใครยังไม่อนุมัติ) / กดได้เฉพาะเจ้าของรายการ
DROP POLICY IF EXISTS "hr_ann_approvals_select" ON hr_announcement_approvals;
DROP POLICY IF EXISTS "hr_ann_approvals_update" ON hr_announcement_approvals;
DROP POLICY IF EXISTS "hr_ann_approvals_write" ON hr_announcement_approvals;
DROP POLICY IF EXISTS "hr_ann_approvals_insert" ON hr_announcement_approvals;
DROP POLICY IF EXISTS "hr_ann_approvals_delete" ON hr_announcement_approvals;
CREATE POLICY "hr_ann_approvals_select" ON hr_announcement_approvals FOR SELECT TO authenticated USING (true);
-- กดอนุมัติ/ปฏิเสธได้เฉพาะรายการของตัวเอง (ผู้จัดการประกาศอนุมัติแทนไม่ได้)
CREATE POLICY "hr_ann_approvals_update" ON hr_announcement_approvals FOR UPDATE TO authenticated
  USING (employee_id = hr_my_employee_id()) WITH CHECK (employee_id = hr_my_employee_id());
CREATE POLICY "hr_ann_approvals_insert" ON hr_announcement_approvals FOR INSERT TO authenticated
  WITH CHECK (hr_can_manage_announcements());
CREATE POLICY "hr_ann_approvals_delete" ON hr_announcement_approvals FOR DELETE TO authenticated
  USING (hr_can_manage_announcements());

-- การรับทราบ: พนักงานกดของตัวเอง / ผู้จัดการดูได้ทั้งหมด
DROP POLICY IF EXISTS "hr_ann_reads_select" ON hr_announcement_reads;
DROP POLICY IF EXISTS "hr_ann_reads_insert" ON hr_announcement_reads;
CREATE POLICY "hr_ann_reads_select" ON hr_announcement_reads FOR SELECT TO authenticated
  USING (hr_can_manage_announcements() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_ann_reads_insert" ON hr_announcement_reads FOR INSERT TO authenticated
  WITH CHECK (employee_id = hr_my_employee_id());

-- =============================================================================
-- RPC
-- =============================================================================

/** สถานะการรับทราบของประกาศ — พนักงานเป้าหมายทุกคน พร้อมธงว่ารับทราบแล้วหรือยัง */
DROP FUNCTION IF EXISTS get_announcement_ack_status(UUID);
CREATE FUNCTION get_announcement_ack_status(p_announcement_id UUID)
RETURNS TABLE (
  employee_id UUID,
  employee_name TEXT,
  department_name TEXT,
  position_name TEXT,
  acknowledged BOOLEAN,
  acknowledged_at TIMESTAMPTZ
) AS $$
BEGIN
  IF NOT hr_can_manage_announcements() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์ดูสถานะการรับทราบ';
  END IF;

  RETURN QUERY
  SELECT
    e.id,
    (trim(concat_ws(' ', e.first_name, e.last_name))
      || CASE WHEN coalesce(e.nickname, '') <> '' THEN ' (' || e.nickname || ')' ELSE '' END)::TEXT,
    d.name::TEXT,
    p.name::TEXT,
    (r.id IS NOT NULL),
    r.acknowledged_at
  FROM hr_announcements a
  JOIN hr_employees e ON e.employment_status IN ('active','probation')
    AND (
      a.target_all_departments
      OR EXISTS (
        SELECT 1 FROM hr_announcement_departments ad
        WHERE ad.announcement_id = a.id AND ad.department_id = e.department_id
      )
    )
  LEFT JOIN hr_departments d ON d.id = e.department_id
  LEFT JOIN hr_positions p ON p.id = e.position_id
  LEFT JOIN hr_announcement_reads r ON r.announcement_id = a.id AND r.employee_id = e.id
  WHERE a.id = p_announcement_id
  ORDER BY (r.id IS NOT NULL), e.first_name;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;

REVOKE ALL ON FUNCTION get_announcement_ack_status(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_announcement_ack_status(UUID) TO authenticated;

/** จำนวนประกาศที่ยังไม่ได้กดรับทราบของพนักงานคนที่เรียก (ใช้แสดง badge) */
DROP FUNCTION IF EXISTS get_my_unread_announcement_count();
CREATE FUNCTION get_my_unread_announcement_count() RETURNS INT AS $$
  SELECT count(*)::INT
  FROM hr_announcements a
  JOIN hr_employees e ON e.id = hr_my_employee_id()
  WHERE a.status = 'published'
    AND (
      a.target_all_departments
      OR EXISTS (
        SELECT 1 FROM hr_announcement_departments d
        WHERE d.announcement_id = a.id AND d.department_id = e.department_id
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM hr_announcement_reads r
      WHERE r.announcement_id = a.id AND r.employee_id = e.id
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public;

REVOKE ALL ON FUNCTION get_my_unread_announcement_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_my_unread_announcement_count() TO authenticated;

-- =============================================================================
-- Storage: ไฟล์แนบประกาศ (ผู้สร้างประกาศอัปโหลดได้ / พนักงานที่ล็อกอินเปิดอ่านได้)
-- =============================================================================
INSERT INTO storage.buckets (id, name, public) VALUES ('hr-announcements', 'hr-announcements', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "hr_announcements_bucket_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_announcements_bucket_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_announcements_bucket_delete" ON storage.objects;
CREATE POLICY "hr_announcements_bucket_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'hr-announcements' AND auth.uid() IS NOT NULL);
CREATE POLICY "hr_announcements_bucket_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'hr-announcements' AND (SELECT hr_can_manage_announcements()));
CREATE POLICY "hr_announcements_bucket_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'hr-announcements' AND (SELECT hr_can_manage_announcements()));

-- Realtime: badge ประกาศใหม่เด้งทันที
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_announcements;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

NOTIFY pgrst, 'reload schema';
