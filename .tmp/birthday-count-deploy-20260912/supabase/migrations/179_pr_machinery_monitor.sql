-- =============================================================================
-- 179: Machinery monitor — เครื่องจักร, ประวัติสถานะ, RLS, realtime, เมนู
-- =============================================================================

BEGIN;

CREATE TYPE pr_machinery_status AS ENUM (
  'working',
  'broken',
  'repairing',
  'idle',
  'decommissioned'
);

CREATE TABLE IF NOT EXISTS pr_machinery_machines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  work_start TIME NOT NULL DEFAULT TIME '08:00',
  work_end TIME NOT NULL DEFAULT TIME '17:00',
  capacity_units_per_hour NUMERIC(14, 4) NOT NULL DEFAULT 0,
  current_status pr_machinery_status NOT NULL DEFAULT 'working',
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_machinery_machines_sort ON pr_machinery_machines(sort_order);
CREATE INDEX IF NOT EXISTS idx_pr_machinery_machines_status ON pr_machinery_machines(current_status);

CREATE TABLE IF NOT EXISTS pr_machinery_status_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  machine_id UUID NOT NULL REFERENCES pr_machinery_machines(id) ON DELETE CASCADE,
  status pr_machinery_status NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_machinery_events_machine ON pr_machinery_status_events(machine_id);
CREATE INDEX IF NOT EXISTS idx_pr_machinery_events_started ON pr_machinery_status_events(started_at);

ALTER TABLE pr_machinery_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE pr_machinery_status_events ENABLE ROW LEVEL SECURITY;

-- Roles ที่อ่านข้อมูล machinery ได้
-- superadmin, admin, production, production_mb, manager, technician

DROP POLICY IF EXISTS "pr_machinery_machines_select" ON pr_machinery_machines;
CREATE POLICY "pr_machinery_machines_select" ON pr_machinery_machines
  FOR SELECT TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  );

DROP POLICY IF EXISTS "pr_machinery_machines_insert" ON pr_machinery_machines;
CREATE POLICY "pr_machinery_machines_insert" ON pr_machinery_machines
  FOR INSERT TO authenticated
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'production'])
  );

DROP POLICY IF EXISTS "pr_machinery_machines_update" ON pr_machinery_machines;
CREATE POLICY "pr_machinery_machines_update" ON pr_machinery_machines
  FOR UPDATE TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'production'])
  )
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'production'])
  );

DROP POLICY IF EXISTS "pr_machinery_machines_delete" ON pr_machinery_machines;
CREATE POLICY "pr_machinery_machines_delete" ON pr_machinery_machines
  FOR DELETE TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY['superadmin', 'admin', 'production'])
  );

DROP POLICY IF EXISTS "pr_machinery_events_select" ON pr_machinery_status_events;
CREATE POLICY "pr_machinery_events_select" ON pr_machinery_status_events
  FOR SELECT TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  );

DROP POLICY IF EXISTS "pr_machinery_events_insert" ON pr_machinery_status_events;
CREATE POLICY "pr_machinery_events_insert" ON pr_machinery_status_events
  FOR INSERT TO authenticated
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  );

DROP POLICY IF EXISTS "pr_machinery_events_update" ON pr_machinery_status_events;
CREATE POLICY "pr_machinery_events_update" ON pr_machinery_status_events
  FOR UPDATE TO authenticated
  USING (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  )
  WITH CHECK (
    check_user_role(auth.uid(), ARRAY[
      'superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician'
    ])
  );

CREATE OR REPLACE FUNCTION pr_machinery_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pr_machinery_machines_updated ON pr_machinery_machines;
CREATE TRIGGER trg_pr_machinery_machines_updated
  BEFORE UPDATE ON pr_machinery_machines
  FOR EACH ROW EXECUTE FUNCTION pr_machinery_set_updated_at();

-- Realtime (optional UI refresh)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE pr_machinery_machines;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE pr_machinery_status_events;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- เมนู desktop (st_user_menus)
INSERT INTO st_user_menus (role, menu_key, menu_name, has_access) VALUES
  ('superadmin', 'machinery', 'Machinery', true),
  ('admin', 'machinery', 'Machinery', true),
  ('production', 'machinery', 'Machinery', true),
  ('superadmin', 'machinery-settings', 'Machinery · ตั้งค่าเครื่อง', true),
  ('admin', 'machinery-settings', 'Machinery · ตั้งค่าเครื่อง', true),
  ('production', 'machinery-settings', 'Machinery · ตั้งค่าเครื่อง', true)
ON CONFLICT (role, menu_key) DO NOTHING;

COMMIT;
