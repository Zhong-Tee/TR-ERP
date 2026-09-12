-- HR งาน: teams, categories, tasks, participants, checklist and private evaluations

CREATE TABLE IF NOT EXISTS hr_task_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_task_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES hr_task_teams(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager','member')),
  starts_on DATE NOT NULL DEFAULT CURRENT_DATE,
  ends_on DATE,
  can_assign BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, employee_id)
);

CREATE TABLE IF NOT EXISTS hr_task_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#059669',
  description TEXT,
  default_due_days INT CHECK (default_due_days IS NULL OR default_due_days >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no TEXT UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  category_id UUID REFERENCES hr_task_categories(id) ON DELETE SET NULL,
  team_id UUID REFERENCES hr_task_teams(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('draft','new','acknowledged','in_progress','review','revision','completed','paused','cancelled')),
  progress INT NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  start_date DATE,
  due_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completion_note TEXT,
  created_by UUID NOT NULL REFERENCES hr_employees(id),
  updated_by UUID REFERENCES hr_employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS hr_task_no_seq START 1;
CREATE OR REPLACE FUNCTION hr_set_task_no() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.task_no IS NULL THEN
    NEW.task_no := 'TASK-' || to_char(CURRENT_DATE, 'YYYYMM') || '-' || lpad(nextval('hr_task_no_seq')::text, 5, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_hr_set_task_no ON hr_tasks;
CREATE TRIGGER trg_hr_set_task_no BEFORE INSERT ON hr_tasks FOR EACH ROW EXECUTE FUNCTION hr_set_task_no();

CREATE TABLE IF NOT EXISTS hr_task_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('assignee','supervisor','coordinator','advisor')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, employee_id, role)
);

CREATE TABLE IF NOT EXISTS hr_task_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  assignee_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  due_at TIMESTAMPTZ,
  is_completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hr_task_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  evaluator_id UUID NOT NULL REFERENCES hr_employees(id) ON DELETE CASCADE,
  speed SMALLINT NOT NULL CHECK (speed BETWEEN 1 AND 5),
  responsibility SMALLINT NOT NULL CHECK (responsibility BETWEEN 1 AND 5),
  quality SMALLINT NOT NULL CHECK (quality BETWEEN 1 AND 5),
  communication SMALLINT NOT NULL CHECK (communication BETWEEN 1 AND 5),
  comment TEXT,
  visibility TEXT NOT NULL DEFAULT 'manager_only' CHECK (visibility IN ('manager_only','employee_visible')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, employee_id, evaluator_id)
);

CREATE INDEX IF NOT EXISTS idx_hr_tasks_status_due ON hr_tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_hr_task_participants_employee ON hr_task_participants(employee_id, task_id);
CREATE INDEX IF NOT EXISTS idx_hr_task_items_task ON hr_task_checklist_items(task_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_hr_task_members_employee ON hr_task_team_members(employee_id, team_id);

CREATE OR REPLACE FUNCTION hr_task_is_related(p_task_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr_tasks t WHERE t.id = p_task_id AND t.created_by = hr_my_employee_id()
  ) OR EXISTS (
    SELECT 1 FROM hr_task_participants p WHERE p.task_id = p_task_id AND p.employee_id = hr_my_employee_id()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION hr_task_can_manage(p_task_id UUID) RETURNS BOOLEAN AS $$
  SELECT hr_is_admin() OR EXISTS (
    SELECT 1 FROM hr_tasks t WHERE t.id = p_task_id AND t.created_by = hr_my_employee_id()
  ) OR EXISTS (
    SELECT 1 FROM hr_task_participants p
    WHERE p.task_id = p_task_id AND p.employee_id = hr_my_employee_id() AND p.role = 'supervisor'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

ALTER TABLE hr_task_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_task_team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_task_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_task_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_task_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr_task_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hr_task_teams_read" ON hr_task_teams FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_task_teams_admin" ON hr_task_teams FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin());
CREATE OR REPLACE FUNCTION hr_task_is_team_manager(p_team_id UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM hr_task_team_members WHERE team_id = p_team_id AND employee_id = hr_my_employee_id() AND role = 'manager');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
CREATE POLICY "hr_task_members_read" ON hr_task_team_members FOR SELECT TO authenticated USING (hr_is_admin() OR employee_id = hr_my_employee_id() OR hr_task_is_team_manager(team_id));
CREATE POLICY "hr_task_members_admin" ON hr_task_team_members FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin());
CREATE POLICY "hr_task_categories_read" ON hr_task_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "hr_task_categories_admin" ON hr_task_categories FOR ALL TO authenticated USING (hr_is_admin()) WITH CHECK (hr_is_admin());

CREATE POLICY "hr_tasks_read" ON hr_tasks FOR SELECT TO authenticated USING (hr_is_admin() OR hr_task_is_related(id));
CREATE POLICY "hr_tasks_create" ON hr_tasks FOR INSERT TO authenticated WITH CHECK (hr_is_admin() OR created_by = hr_my_employee_id());
CREATE POLICY "hr_tasks_update" ON hr_tasks FOR UPDATE TO authenticated USING (hr_task_is_related(id)) WITH CHECK (hr_task_is_related(id));
CREATE POLICY "hr_tasks_delete" ON hr_tasks FOR DELETE TO authenticated USING (hr_task_can_manage(id));

CREATE POLICY "hr_task_participants_read" ON hr_task_participants FOR SELECT TO authenticated USING (hr_is_admin() OR hr_task_is_related(task_id));
CREATE POLICY "hr_task_participants_manage" ON hr_task_participants FOR ALL TO authenticated USING (hr_task_can_manage(task_id)) WITH CHECK (hr_task_can_manage(task_id));
CREATE POLICY "hr_task_items_read" ON hr_task_checklist_items FOR SELECT TO authenticated USING (hr_is_admin() OR hr_task_is_related(task_id));
CREATE POLICY "hr_task_items_insert" ON hr_task_checklist_items FOR INSERT TO authenticated WITH CHECK (hr_task_can_manage(task_id));
CREATE POLICY "hr_task_items_update" ON hr_task_checklist_items FOR UPDATE TO authenticated USING (hr_task_is_related(task_id)) WITH CHECK (hr_task_is_related(task_id));
CREATE POLICY "hr_task_items_delete" ON hr_task_checklist_items FOR DELETE TO authenticated USING (hr_task_can_manage(task_id));

CREATE POLICY "hr_task_evaluations_read" ON hr_task_evaluations FOR SELECT TO authenticated USING (
  hr_is_admin() OR evaluator_id = hr_my_employee_id() OR (employee_id = hr_my_employee_id() AND visibility = 'employee_visible')
);
CREATE POLICY "hr_task_evaluations_manage" ON hr_task_evaluations FOR ALL TO authenticated USING (hr_task_can_manage(task_id)) WITH CHECK (hr_task_can_manage(task_id) AND evaluator_id = hr_my_employee_id());

CREATE OR REPLACE FUNCTION hr_task_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.role IN ('assignee','coordinator','advisor') THEN
    INSERT INTO hr_notifications(employee_id, type, title, message, link, related_id)
    SELECT NEW.employee_id, 'task_new',
      CASE NEW.role WHEN 'assignee' THEN 'ได้รับมอบหมายงานใหม่' WHEN 'coordinator' THEN 'ถูกเพิ่มเป็นผู้ประสานงาน' ELSE 'ถูกเพิ่มเป็นที่ปรึกษางาน' END,
      t.title, '/employee?tab=tasks', NEW.task_id FROM hr_tasks t WHERE t.id = NEW.task_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_hr_task_notify ON hr_task_participants;
CREATE TRIGGER trg_hr_task_notify AFTER INSERT ON hr_task_participants FOR EACH ROW EXECUTE FUNCTION hr_task_notify();

CREATE OR REPLACE FUNCTION hr_task_status_notify() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('review','revision','completed') THEN
    INSERT INTO hr_notifications(employee_id, type, title, message, link, related_id)
    SELECT p.employee_id, 'task_' || NEW.status,
      CASE NEW.status WHEN 'review' THEN 'มีงานรอตรวจ' WHEN 'revision' THEN 'งานถูกขอให้แก้ไข' ELSE 'งานเสร็จสมบูรณ์' END,
      NEW.title,
      CASE WHEN p.role = 'assignee' THEN '/employee?tab=tasks' ELSE '/hr/tasks' END,
      NEW.id
    FROM hr_task_participants p
    WHERE p.task_id = NEW.id AND p.role IN (CASE WHEN NEW.status = 'review' THEN 'supervisor' ELSE 'assignee' END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_hr_task_status_notify ON hr_tasks;
CREATE TRIGGER trg_hr_task_status_notify AFTER UPDATE OF status ON hr_tasks FOR EACH ROW EXECUTE FUNCTION hr_task_status_notify();

-- Call hourly/daily from Supabase Cron. NOT EXISTS makes repeated calls idempotent per day.
CREATE OR REPLACE FUNCTION hr_generate_task_due_notifications() RETURNS INT AS $$
DECLARE v_count INT;
BEGIN
  INSERT INTO hr_notifications(employee_id, type, title, message, link, related_id)
  SELECT p.employee_id,
    CASE WHEN t.due_at < now() THEN 'task_overdue' ELSE 'task_due_soon' END,
    CASE WHEN t.due_at < now() THEN 'งานเลยกำหนด' ELSE 'งานใกล้ถึงกำหนด' END,
    t.title, '/employee?tab=tasks', t.id
  FROM hr_tasks t JOIN hr_task_participants p ON p.task_id = t.id AND p.role = 'assignee'
  WHERE t.status IN ('new','acknowledged','in_progress','revision')
    AND t.due_at <= now() + interval '1 day'
    AND NOT EXISTS (
      SELECT 1 FROM hr_notifications n WHERE n.employee_id = p.employee_id AND n.related_id = t.id
        AND n.type = CASE WHEN t.due_at < now() THEN 'task_overdue' ELSE 'task_due_soon' END
        AND n.created_at::date = CURRENT_DATE
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION hr_task_recalculate_progress() RETURNS TRIGGER AS $$
DECLARE v_task UUID; v_total INT; v_done INT;
BEGIN
  v_task := COALESCE(NEW.task_id, OLD.task_id);
  SELECT count(*), count(*) FILTER (WHERE is_completed) INTO v_total, v_done FROM hr_task_checklist_items WHERE task_id = v_task;
  UPDATE hr_tasks SET progress = CASE WHEN v_total = 0 THEN progress ELSE round(v_done * 100.0 / v_total)::INT END, updated_at = now() WHERE id = v_task;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
DROP TRIGGER IF EXISTS trg_hr_task_progress ON hr_task_checklist_items;
CREATE TRIGGER trg_hr_task_progress AFTER INSERT OR UPDATE OR DELETE ON hr_task_checklist_items FOR EACH ROW EXECUTE FUNCTION hr_task_recalculate_progress();

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE hr_tasks; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO hr_task_categories(name, color) VALUES
  ('งานทั่วไป', '#059669'), ('งานเอกสาร', '#2563eb'), ('งานประสานงาน', '#7c3aed'), ('งานเร่งด่วน', '#dc2626')
ON CONFLICT (name) DO NOTHING;
