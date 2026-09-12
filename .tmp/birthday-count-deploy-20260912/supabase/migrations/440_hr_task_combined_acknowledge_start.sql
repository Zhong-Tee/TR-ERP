-- Combined "acknowledge and start" changes new -> in_progress in one update.
-- Record the acknowledgement milestone separately so SLA history remains complete.

CREATE OR REPLACE FUNCTION hr_task_record_combined_acknowledgement() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.acknowledged_at IS NULL
    AND NEW.acknowledged_at IS NOT NULL
    AND NEW.status <> 'acknowledged' THEN
    INSERT INTO hr_task_events(task_id, event_type, from_status, to_status, actor_id, event_at, details)
    VALUES (
      NEW.id,
      'acknowledged',
      OLD.status,
      NEW.status,
      hr_my_employee_id(),
      NEW.acknowledged_at,
      jsonb_build_object(
        'response_minutes', GREATEST(0, floor(extract(epoch FROM (NEW.acknowledged_at - NEW.created_at)) / 60)),
        'sla_minutes', 30,
        'met_sla', NEW.acknowledged_at <= NEW.created_at + interval '30 minutes'
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_task_combined_acknowledgement ON hr_tasks;
CREATE TRIGGER trg_hr_task_combined_acknowledgement
AFTER UPDATE OF acknowledged_at ON hr_tasks
FOR EACH ROW EXECUTE FUNCTION hr_task_record_combined_acknowledgement();
