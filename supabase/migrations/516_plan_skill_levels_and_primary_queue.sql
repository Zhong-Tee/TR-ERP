-- Skill Matrix แบบ 4 ระดับ และบทบาทหัวหน้ารายกระบวนการ
-- เก็บคอลัมน์เดิมไว้ระหว่าง rollout เพื่อให้ client รุ่นเก่ายังอ่านข้อมูลได้
ALTER TABLE public.plan_employee_skills
  ADD COLUMN IF NOT EXISTS skill_level SMALLINT,
  ADD COLUMN IF NOT EXISTS is_supervisor BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS primary_queue_order INTEGER;

UPDATE public.plan_employee_skills
SET skill_level = CASE
  WHEN qualification_status = 'blocked' THEN 0
  WHEN qualification_status = 'training' THEN 1
  WHEN proficiency >= 4 THEN 3
  ELSE 2
END
WHERE skill_level IS NULL;

-- ย้ายหัวหน้าแบบเดิมมาเป็นหัวหน้าเฉพาะกระบวนการที่ทำได้
UPDATE public.plan_employee_skills skill
SET is_supervisor = true
FROM public.plan_employee_profiles profile
WHERE profile.employee_id = skill.employee_id
  AND profile.responsibility_level IN ('supervisor','lead')
  AND skill.skill_level >= 2;

-- งานหลัก/หัวหน้าต้องทำกระบวนการนั้นได้อย่างน้อยระดับ "ทำได้"
UPDATE public.plan_employee_skills
SET is_primary = false, primary_queue_order = NULL
WHERE skill_level < 2;

UPDATE public.plan_employee_skills
SET is_supervisor = false
WHERE skill_level < 2;

UPDATE public.plan_employee_skills
SET max_concurrent_jobs = 1
WHERE skill_level <= 1;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY department_name, process_name
    ORDER BY COALESCE(primary_queue_order, 2147483647), created_at, employee_id
  ) AS queue_order
  FROM public.plan_employee_skills
  WHERE is_primary
)
UPDATE public.plan_employee_skills skill
SET primary_queue_order = ranked.queue_order
FROM ranked
WHERE ranked.id = skill.id;

ALTER TABLE public.plan_employee_skills
  ALTER COLUMN skill_level SET DEFAULT 0,
  ALTER COLUMN skill_level SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plan_employee_skills_skill_level_check'
      AND conrelid = 'public.plan_employee_skills'::regclass
  ) THEN
    ALTER TABLE public.plan_employee_skills
      ADD CONSTRAINT plan_employee_skills_skill_level_check CHECK (skill_level BETWEEN 0 AND 3),
      ADD CONSTRAINT plan_employee_skills_primary_level_check CHECK (NOT is_primary OR skill_level >= 2),
      ADD CONSTRAINT plan_employee_skills_supervisor_level_check CHECK (NOT is_supervisor OR skill_level >= 2),
      ADD CONSTRAINT plan_employee_skills_queue_order_check CHECK (primary_queue_order IS NULL OR primary_queue_order > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plan_employee_skills_primary_queue
  ON public.plan_employee_skills(department_name, process_name, primary_queue_order)
  WHERE is_primary AND primary_queue_order IS NOT NULL;

CREATE OR REPLACE FUNCTION public.plan_prepare_employee_skill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- ซิงก์กลับไปยังฟิลด์เดิมสำหรับหน้าหรือรายงานรุ่นเก่า
  NEW.qualification_status := CASE
    WHEN NEW.skill_level = 0 THEN 'blocked'
    WHEN NEW.skill_level = 1 THEN 'training'
    ELSE 'qualified'
  END;
  NEW.proficiency := CASE NEW.skill_level WHEN 3 THEN 4 WHEN 2 THEN 3 ELSE 1 END;
  NEW.efficiency_percent := 100;

  IF NEW.skill_level < 2 THEN
    NEW.is_primary := false;
    NEW.is_supervisor := false;
  END IF;
  IF NEW.skill_level <= 1 THEN
    NEW.max_concurrent_jobs := 1;
  END IF;

  IF NOT NEW.is_primary THEN
    NEW.primary_queue_order := NULL;
  ELSIF NEW.primary_queue_order IS NULL THEN
    SELECT COALESCE(MAX(skill.primary_queue_order), 0) + 1
    INTO NEW.primary_queue_order
    FROM public.plan_employee_skills skill
    WHERE skill.department_name = NEW.department_name
      AND skill.process_name = NEW.process_name
      AND skill.is_primary
      AND (TG_OP = 'INSERT' OR skill.id <> NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_plan_prepare_employee_skill ON public.plan_employee_skills;
CREATE TRIGGER trg_plan_prepare_employee_skill
BEFORE INSERT OR UPDATE OF skill_level, is_primary, is_supervisor, primary_queue_order
ON public.plan_employee_skills
FOR EACH ROW EXECUTE FUNCTION public.plan_prepare_employee_skill();

COMMENT ON COLUMN public.plan_employee_skills.skill_level IS '0=ทำไม่ได้, 1=ฝึกงาน, 2=ทำได้, 3=เชี่ยวชาญ';
COMMENT ON COLUMN public.plan_employee_skills.is_supervisor IS 'เป็นหัวหน้าคุมงานเฉพาะกระบวนการนี้';
COMMENT ON COLUMN public.plan_employee_skills.primary_queue_order IS 'ลำดับ Round-robin ของผู้รับผิดชอบงานหลักในกระบวนการ';

CREATE OR REPLACE FUNCTION public.plan_reorder_primary_queue(
  p_department_name TEXT,
  p_process_name TEXT,
  p_employee_ids UUID[]
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expected_count INTEGER;
  v_submitted_count INTEGER;
BEGIN
  IF NOT public.hr_is_admin() THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์จัดลำดับคิวงานหลัก';
  END IF;

  SELECT COUNT(*) INTO v_expected_count
  FROM public.plan_employee_skills
  WHERE department_name = p_department_name
    AND process_name = p_process_name
    AND is_primary;

  SELECT COUNT(DISTINCT submitted.employee_id) INTO v_submitted_count
  FROM unnest(COALESCE(p_employee_ids, ARRAY[]::UUID[])) AS submitted(employee_id);

  IF v_submitted_count <> v_expected_count OR EXISTS (
    SELECT 1
    FROM unnest(COALESCE(p_employee_ids, ARRAY[]::UUID[])) submitted(employee_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.plan_employee_skills skill
      WHERE skill.employee_id = submitted.employee_id
        AND skill.department_name = p_department_name
        AND skill.process_name = p_process_name
        AND skill.is_primary
    )
  ) THEN
    RAISE EXCEPTION 'รายชื่อคิวงานหลักมีการเปลี่ยนแปลง กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง';
  END IF;

  UPDATE public.plan_employee_skills skill
  SET primary_queue_order = ordered.queue_order
  FROM unnest(p_employee_ids) WITH ORDINALITY ordered(employee_id, queue_order)
  WHERE skill.employee_id = ordered.employee_id
    AND skill.department_name = p_department_name
    AND skill.process_name = p_process_name
    AND skill.is_primary;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_reorder_primary_queue(TEXT,TEXT,UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plan_reorder_primary_queue(TEXT,TEXT,UUID[]) TO authenticated;

-- งานซ้อนใช้ได้ภายในกระบวนการเดียวกันเท่านั้น ไม่ให้คนหนึ่งทำคนละกระบวนการในเวลาทับกัน
CREATE OR REPLACE FUNCTION public.plan_prevent_cross_process_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status NOT IN ('cancelled','completed') AND EXISTS (
    SELECT 1
    FROM public.plan_worker_assignments assignment
    WHERE assignment.employee_id = NEW.employee_id
      AND assignment.id <> NEW.id
      AND assignment.status NOT IN ('cancelled','completed')
      AND (assignment.department_name, assignment.process_name) IS DISTINCT FROM (NEW.department_name, NEW.process_name)
      AND LEAST(assignment.planned_end, NEW.planned_end) - GREATEST(assignment.planned_start, NEW.planned_start) > INTERVAL '5 minutes'
  ) THEN
    RAISE EXCEPTION 'พนักงานมีงานคนละกระบวนการในช่วงเวลานี้แล้ว งานซ้อนอนุญาตเฉพาะกระบวนการเดียวกัน';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_plan_prevent_cross_process_overlap ON public.plan_worker_assignments;
CREATE TRIGGER trg_plan_prevent_cross_process_overlap
BEFORE INSERT OR UPDATE OF employee_id, department_name, process_name, planned_start, planned_end, status
ON public.plan_worker_assignments
FOR EACH ROW EXECUTE FUNCTION public.plan_prevent_cross_process_overlap();

NOTIFY pgrst, 'reload schema';
