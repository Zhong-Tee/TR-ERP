-- =============================================================================
-- HR Time Clock: บันทึกเวลาเข้า-ออกงานด้วย GPS + กล้อง, จุดพิกัดออฟฟิศ, คำขอ OT
-- IDEMPOTENT: safe to re-run
-- =============================================================================

-- ─── 1. us_users.employee_access — สวิตช์เปิดสิทธิ์เข้าหน้า Employee บนมือถือ ──
ALTER TABLE us_users ADD COLUMN IF NOT EXISTS employee_access BOOLEAN DEFAULT false;

-- ─── 2. hr_clock_locations — จุดพิกัดออฟฟิศ (เพิ่มได้หลายจุด ตั้งชื่อเอง) ─────
CREATE TABLE IF NOT EXISTS hr_clock_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_m INT NOT NULL DEFAULT 100,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── 3. hr_employees.clock_location_id — จุดบันทึกเวลาประจำตัวพนักงาน ────────
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS clock_location_id UUID REFERENCES hr_clock_locations(id) ON DELETE SET NULL;

-- ─── 4. hr_time_entries — บันทึกเวลาเข้า-ออกงาน/OT ──────────────────────────
CREATE TABLE IF NOT EXISTS hr_time_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('clock_in','clock_out','ot_in','ot_out')),
  work_date DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Bangkok')::DATE),
  entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  accuracy_m NUMERIC(8,1),
  distance_m NUMERIC(10,1),
  location_id UUID REFERENCES hr_clock_locations(id) ON DELETE SET NULL,
  location_name TEXT,
  photo_url TEXT,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_time_entries_employee ON hr_time_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_time_entries_date ON hr_time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_hr_time_entries_emp_date ON hr_time_entries(employee_id, work_date);

-- ─── 5. hr_ot_requests — คำขอ OT (ต้องอนุมัติก่อนจึงกดเข้า OT ได้) ──────────
CREATE TABLE IF NOT EXISTS hr_ot_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  request_date DATE NOT NULL,
  ot_start TIME NOT NULL,
  ot_end TIME NOT NULL,
  hours NUMERIC(5,2),
  reason TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approved_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  reject_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hr_ot_requests_employee ON hr_ot_requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_hr_ot_requests_status ON hr_ot_requests(status);
CREATE INDEX IF NOT EXISTS idx_hr_ot_requests_date ON hr_ot_requests(request_date);

-- ─── 6. hr_clock_settings — ค่ากลางเวลาทำงาน (แถวเดียว) ─────────────────────
CREATE TABLE IF NOT EXISTS hr_clock_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_start TIME NOT NULL DEFAULT '08:00',
  work_end TIME NOT NULL DEFAULT '17:00',
  late_grace_min INT NOT NULL DEFAULT 0,
  -- วันทำงานต่อสัปดาห์ (ISO: 1=จันทร์ ... 7=อาทิตย์) ใช้คำนวณวันขาดงาน
  work_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO hr_clock_settings (work_start, work_end, late_grace_min)
SELECT '08:00', '17:00', 0
WHERE NOT EXISTS (SELECT 1 FROM hr_clock_settings);

-- =============================================================================
-- RLS
-- =============================================================================
ALTER TABLE hr_clock_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_ot_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_clock_settings ENABLE ROW LEVEL SECURITY;

-- helper: superadmin เท่านั้น (ใช้กับการแก้พิกัด/ตั้งค่าเวลา)
CREATE OR REPLACE FUNCTION hr_is_superadmin() RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM us_users WHERE id = auth.uid() AND role = 'superadmin'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- hr_clock_locations: ทุกคนที่ล็อกอินอ่านได้ (พนักงานต้องใช้คำนวณระยะ), superadmin จัดการ
DROP POLICY IF EXISTS "hr_clock_locations_select" ON hr_clock_locations;
DROP POLICY IF EXISTS "hr_clock_locations_manage" ON hr_clock_locations;
CREATE POLICY "hr_clock_locations_select" ON hr_clock_locations FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_clock_locations_manage" ON hr_clock_locations FOR ALL TO authenticated USING (hr_is_superadmin());

-- hr_time_entries: พนักงาน insert/อ่านของตัวเอง, ห้ามแก้/ลบ (กันแก้เวลาย้อนหลัง), HR/admin อ่านทั้งหมด, superadmin ลบได้
DROP POLICY IF EXISTS "hr_time_entries_select" ON hr_time_entries;
DROP POLICY IF EXISTS "hr_time_entries_insert" ON hr_time_entries;
DROP POLICY IF EXISTS "hr_time_entries_delete" ON hr_time_entries;
CREATE POLICY "hr_time_entries_select" ON hr_time_entries FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_time_entries_insert" ON hr_time_entries FOR INSERT TO authenticated WITH CHECK (employee_id = hr_my_employee_id() OR hr_is_admin());
CREATE POLICY "hr_time_entries_delete" ON hr_time_entries FOR DELETE TO authenticated USING (hr_is_superadmin());

-- hr_ot_requests: พนักงานสร้าง/อ่าน/ยกเลิกของตัวเอง, HR/admin จัดการทั้งหมด
DROP POLICY IF EXISTS "hr_ot_requests_select" ON hr_ot_requests;
DROP POLICY IF EXISTS "hr_ot_requests_insert" ON hr_ot_requests;
DROP POLICY IF EXISTS "hr_ot_requests_update" ON hr_ot_requests;
DROP POLICY IF EXISTS "hr_ot_requests_delete" ON hr_ot_requests;
CREATE POLICY "hr_ot_requests_select" ON hr_ot_requests FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_ot_requests_insert" ON hr_ot_requests FOR INSERT TO authenticated WITH CHECK (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_ot_requests_update" ON hr_ot_requests FOR UPDATE TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id());
CREATE POLICY "hr_ot_requests_delete" ON hr_ot_requests FOR DELETE TO authenticated USING (hr_is_admin());

-- hr_clock_settings: ทุกคนอ่านได้ (ใช้คำนวณสาย), superadmin แก้
DROP POLICY IF EXISTS "hr_clock_settings_select" ON hr_clock_settings;
DROP POLICY IF EXISTS "hr_clock_settings_manage" ON hr_clock_settings;
CREATE POLICY "hr_clock_settings_select" ON hr_clock_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_clock_settings_manage" ON hr_clock_settings FOR ALL TO authenticated USING (hr_is_superadmin());

-- =============================================================================
-- Triggers
-- =============================================================================
DROP TRIGGER IF EXISTS trg_hr_clock_locations_updated ON hr_clock_locations;
CREATE TRIGGER trg_hr_clock_locations_updated BEFORE UPDATE ON hr_clock_locations FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_ot_requests_updated ON hr_ot_requests;
CREATE TRIGGER trg_hr_ot_requests_updated BEFORE UPDATE ON hr_ot_requests FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

DROP TRIGGER IF EXISTS trg_hr_clock_settings_updated ON hr_clock_settings;
CREATE TRIGGER trg_hr_clock_settings_updated BEFORE UPDATE ON hr_clock_settings FOR EACH ROW EXECUTE FUNCTION hr_set_updated_at();

-- แจ้งเตือนคำขอ OT (ลอกแบบ hr_leave_notify)
CREATE OR REPLACE FUNCTION hr_ot_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'ot_approval_pending', 'มีคำขอ OT รออนุมัติ',
      NEW.reason, '/hr/leave', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin','admin')
    LIMIT 5;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status IN ('approved','rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'ot_result',
      CASE WHEN NEW.status = 'approved' THEN 'คำขอ OT ได้รับการอนุมัติ' ELSE 'คำขอ OT ถูกปฏิเสธ' END,
      COALESCE(NEW.reject_reason, ''),
      '/employee',
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_hr_ot_notify ON hr_ot_requests;
CREATE TRIGGER trg_hr_ot_notify
  AFTER INSERT OR UPDATE ON hr_ot_requests
  FOR EACH ROW EXECUTE FUNCTION hr_ot_notify();

-- =============================================================================
-- Realtime
-- =============================================================================
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_time_entries;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hr_ot_requests;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- Storage bucket: รูปถ่ายตอนบันทึกเวลา
-- =============================================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('hr-time-clock', 'hr-time-clock', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "hr_time_clock_select" ON storage.objects;
DROP POLICY IF EXISTS "hr_time_clock_insert" ON storage.objects;
DROP POLICY IF EXISTS "hr_time_clock_delete" ON storage.objects;

CREATE POLICY "hr_time_clock_select" ON storage.objects FOR SELECT
  USING (bucket_id = 'hr-time-clock' AND auth.uid() IS NOT NULL);
CREATE POLICY "hr_time_clock_insert" ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'hr-time-clock' AND auth.uid() IS NOT NULL);
CREATE POLICY "hr_time_clock_delete" ON storage.objects FOR DELETE
  USING (bucket_id = 'hr-time-clock' AND (SELECT hr_is_superadmin()));
