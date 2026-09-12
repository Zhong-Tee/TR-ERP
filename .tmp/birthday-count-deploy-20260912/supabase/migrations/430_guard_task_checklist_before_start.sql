-- Checklist progress is work activity. It must not be changed before the assignee
-- starts the task, nor while the task is waiting for review/closed.
CREATE OR REPLACE FUNCTION hr_guard_task_checklist_update()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF OLD.is_completed IS NOT DISTINCT FROM NEW.is_completed THEN
    RETURN NEW;
  END IF;

  SELECT status::TEXT INTO v_status
  FROM hr_tasks
  WHERE id = NEW.task_id;

  IF v_status NOT IN ('in_progress', 'revision') THEN
    RAISE EXCEPTION 'ต้องเริ่มทำงานก่อนจึงจะเช็กรายการงานได้'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_guard_task_checklist_update ON hr_task_checklist_items;
CREATE TRIGGER trg_hr_guard_task_checklist_update
BEFORE UPDATE OF is_completed ON hr_task_checklist_items
FOR EACH ROW EXECUTE FUNCTION hr_guard_task_checklist_update();
