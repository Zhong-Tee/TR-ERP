-- Team task workflow: each assignee acknowledges and completes their own part.
-- The primary assignee combines the work and submits it for review.

ALTER TABLE public.hr_task_participants
  ADD COLUMN IF NOT EXISTS work_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (work_status IN ('pending', 'in_progress', 'completed')),
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_note TEXT,
  ADD COLUMN IF NOT EXISTS submission_link TEXT;

-- Preserve sensible per-person state for tasks created before this migration.
UPDATE public.hr_task_participants participant
SET work_status = CASE
      WHEN task.status IN ('review', 'completed') THEN 'completed'
      WHEN task.status IN ('acknowledged', 'in_progress', 'revision', 'paused') THEN 'in_progress'
      ELSE 'pending'
    END,
    acknowledged_at = CASE
      WHEN task.status NOT IN ('draft', 'new', 'cancelled')
        THEN COALESCE(participant.acknowledged_at, task.acknowledged_at, task.created_at)
      ELSE participant.acknowledged_at
    END,
    started_at = CASE
      WHEN task.status IN ('in_progress', 'review', 'revision', 'completed', 'paused')
        THEN COALESCE(participant.started_at, task.started_at, task.acknowledged_at, task.created_at)
      ELSE participant.started_at
    END,
    completed_at = CASE
      WHEN task.status IN ('review', 'completed')
        THEN COALESCE(participant.completed_at, task.submitted_at, task.completed_at)
      ELSE participant.completed_at
    END
FROM public.hr_tasks task
WHERE participant.task_id = task.id
  AND participant.role = 'assignee';

CREATE OR REPLACE FUNCTION public.hr_task_acknowledge_my_part(p_task_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_employee UUID := public.hr_my_employee_id();
  v_now TIMESTAMPTZ := now();
BEGIN
  UPDATE public.hr_task_participants participant
  SET work_status = 'in_progress',
      acknowledged_at = COALESCE(participant.acknowledged_at, v_now),
      started_at = COALESCE(participant.started_at, v_now)
  FROM public.hr_tasks task
  WHERE participant.task_id = p_task_id
    AND participant.employee_id = v_employee
    AND participant.role = 'assignee'
    AND participant.work_status = 'pending'
    AND task.id = participant.task_id
    AND task.status NOT IN ('completed', 'cancelled');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบงานที่รอรับทราบ หรือคุณรับทราบงานนี้แล้ว';
  END IF;

  UPDATE public.hr_tasks
  SET status = CASE WHEN status IN ('new', 'acknowledged') THEN 'in_progress' ELSE status END,
      acknowledged_at = COALESCE(acknowledged_at, v_now),
      started_at = COALESCE(started_at, v_now),
      updated_at = v_now
  WHERE id = p_task_id
    AND status NOT IN ('completed', 'cancelled');
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_task_complete_my_part(
  p_task_id UUID,
  p_note TEXT DEFAULT NULL,
  p_link TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_employee UUID := public.hr_my_employee_id();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(p_link, '')), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาแนบลิงก์ผลงาน หรือกรอกข้อความสรุปงานอย่างน้อย 1 รายการ';
  END IF;

  UPDATE public.hr_task_participants participant
  SET work_status = 'completed',
      acknowledged_at = COALESCE(participant.acknowledged_at, v_now),
      started_at = COALESCE(participant.started_at, v_now),
      completed_at = v_now,
      submission_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
      submission_link = NULLIF(btrim(COALESCE(p_link, '')), '')
  FROM public.hr_tasks task
  WHERE participant.task_id = p_task_id
    AND participant.employee_id = v_employee
    AND participant.role = 'assignee'
    AND task.id = participant.task_id
    AND task.status IN ('in_progress', 'revision');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบงานที่กำลังทำ หรือไม่มีสิทธิ์บันทึกส่วนงานนี้';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_task_submit_team(
  p_task_id UUID,
  p_note TEXT DEFAULT NULL,
  p_link TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_employee UUID := public.hr_my_employee_id();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.hr_task_participants
    WHERE task_id = p_task_id AND employee_id = v_employee
      AND role = 'assignee' AND is_primary
  ) THEN
    RAISE EXCEPTION 'เฉพาะผู้รับผิดชอบหลักเท่านั้นที่ส่งงานรวมเพื่อตรวจได้';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hr_task_participants
    WHERE task_id = p_task_id AND role = 'assignee' AND work_status <> 'completed'
  ) THEN
    RAISE EXCEPTION 'สมาชิกผู้รับผิดชอบยังทำส่วนงานไม่ครบ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.hr_task_checklist_items
    WHERE task_id = p_task_id AND NOT is_completed
  ) THEN
    RAISE EXCEPTION 'กรุณาเช็กรายการงานให้ครบก่อนส่งตรวจ';
  END IF;

  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(p_link, '')), '') IS NULL THEN
    RAISE EXCEPTION 'กรุณาแนบลิงก์ผลงาน หรือกรอกข้อความส่งงานอย่างน้อย 1 รายการ';
  END IF;

  UPDATE public.hr_tasks
  SET status = 'review',
      submitted_at = v_now,
      completion_note = NULLIF(btrim(COALESCE(p_note, '')), ''),
      completion_link = NULLIF(btrim(COALESCE(p_link, '')), ''),
      updated_at = v_now
  WHERE id = p_task_id
    AND status IN ('in_progress', 'revision');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'งานนี้ไม่อยู่ในสถานะที่ส่งตรวจได้';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_task_reset_assignees_on_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'revision' THEN
    UPDATE public.hr_task_participants
    SET work_status = 'in_progress', completed_at = NULL
    WHERE task_id = NEW.id AND role = 'assignee';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_task_reset_assignees_on_revision ON public.hr_tasks;
CREATE TRIGGER trg_hr_task_reset_assignees_on_revision
AFTER UPDATE OF status ON public.hr_tasks
FOR EACH ROW EXECUTE FUNCTION public.hr_task_reset_assignees_on_revision();

REVOKE ALL ON FUNCTION public.hr_task_acknowledge_my_part(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_task_complete_my_part(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hr_task_submit_team(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_task_acknowledge_my_part(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_task_complete_my_part(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_task_submit_team(UUID, TEXT, TEXT) TO authenticated;
