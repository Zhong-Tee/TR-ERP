-- A task can enter review only after every checklist item is complete and the
-- assignee provides either a submission note or a work link.
CREATE OR REPLACE FUNCTION hr_validate_task_submission()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'review' THEN
    IF EXISTS (
      SELECT 1 FROM hr_task_checklist_items
      WHERE task_id = NEW.id AND is_completed = false
    ) THEN
      RAISE EXCEPTION 'กรุณาเช็กรายการงานให้ครบก่อนส่งตรวจ'
        USING ERRCODE = 'P0001';
    END IF;

    IF NULLIF(btrim(COALESCE(NEW.completion_note, '')), '') IS NULL
       AND NULLIF(btrim(COALESCE(NEW.completion_link, '')), '') IS NULL THEN
      RAISE EXCEPTION 'กรุณาแนบลิงก์ผลงาน หรือกรอกข้อความส่งงานอย่างน้อย 1 รายการ'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_validate_task_submission ON hr_tasks;
CREATE TRIGGER trg_hr_validate_task_submission
BEFORE UPDATE OF status, completion_note, completion_link ON hr_tasks
FOR EACH ROW EXECUTE FUNCTION hr_validate_task_submission();
