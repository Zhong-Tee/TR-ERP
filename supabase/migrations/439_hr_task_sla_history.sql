-- Preserve the first submission used by deadline SLA and keep an immutable task timeline.

ALTER TABLE hr_tasks ADD COLUMN IF NOT EXISTS first_submitted_at TIMESTAMPTZ;

UPDATE hr_tasks
SET first_submitted_at = submitted_at
WHERE first_submitted_at IS NULL AND submitted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS hr_task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES hr_tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  actor_id UUID REFERENCES hr_employees(id) ON DELETE SET NULL,
  event_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_hr_task_events_task_time
  ON hr_task_events(task_id, event_at);

ALTER TABLE hr_task_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hr_task_events_read" ON hr_task_events;
CREATE POLICY "hr_task_events_read" ON hr_task_events
  FOR SELECT TO authenticated
  USING (hr_is_admin() OR hr_task_is_related(task_id));

-- The first submission must never move when a revision is submitted later.
CREATE OR REPLACE FUNCTION hr_task_preserve_first_submission() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'review' AND OLD.status IS DISTINCT FROM 'review' THEN
    NEW.first_submitted_at := COALESCE(OLD.first_submitted_at, NEW.submitted_at, now());
  ELSE
    NEW.first_submitted_at := OLD.first_submitted_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hr_task_preserve_first_submission ON hr_tasks;
CREATE TRIGGER trg_hr_task_preserve_first_submission
BEFORE UPDATE OF status, submitted_at, first_submitted_at ON hr_tasks
FOR EACH ROW EXECUTE FUNCTION hr_task_preserve_first_submission();

CREATE OR REPLACE FUNCTION hr_task_record_event() RETURNS TRIGGER AS $$
DECLARE
  v_event_type TEXT;
  v_details JSONB := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_task_events(task_id, event_type, to_status, actor_id, event_at, details)
    VALUES (NEW.id, 'assigned', NEW.status, NEW.created_by, NEW.created_at, jsonb_build_object('due_at', NEW.due_at));
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  v_event_type := CASE NEW.status
    WHEN 'acknowledged' THEN 'acknowledged'
    WHEN 'in_progress' THEN 'started'
    WHEN 'review' THEN 'submitted'
    WHEN 'revision' THEN 'revision_requested'
    WHEN 'completed' THEN 'completed'
    WHEN 'paused' THEN 'paused'
    WHEN 'cancelled' THEN 'cancelled'
    ELSE 'status_changed'
  END;

  IF NEW.status = 'acknowledged' THEN
    v_details := jsonb_build_object(
      'response_minutes', GREATEST(0, floor(extract(epoch FROM (COALESCE(NEW.acknowledged_at, now()) - NEW.created_at)) / 60)),
      'sla_minutes', 30,
      'met_sla', COALESCE(NEW.acknowledged_at, now()) <= NEW.created_at + interval '30 minutes'
    );
  ELSIF NEW.status = 'review' THEN
    v_details := jsonb_build_object(
      'due_at', NEW.due_at,
      'deadline_variance_minutes', CASE WHEN NEW.due_at IS NULL THEN NULL ELSE floor(extract(epoch FROM (COALESCE(NEW.submitted_at, now()) - NEW.due_at)) / 60) END,
      'work_minutes', CASE WHEN NEW.started_at IS NULL THEN NULL ELSE GREATEST(0, floor(extract(epoch FROM (COALESCE(NEW.submitted_at, now()) - NEW.started_at)) / 60)) END
    );
  END IF;

  INSERT INTO hr_task_events(task_id, event_type, from_status, to_status, actor_id, event_at, details)
  VALUES (NEW.id, v_event_type, OLD.status, NEW.status, hr_my_employee_id(), now(), v_details);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_hr_task_record_event ON hr_tasks;
CREATE TRIGGER trg_hr_task_record_event
AFTER INSERT OR UPDATE OF status ON hr_tasks
FOR EACH ROW EXECUTE FUNCTION hr_task_record_event();

-- Backfill the timeline for existing tasks. Exact status transitions before these
-- timestamps are unavailable, so each known milestone is recorded independently.
INSERT INTO hr_task_events(task_id, event_type, to_status, actor_id, event_at, details)
SELECT t.id, e.event_type, e.to_status, t.created_by, e.event_at, e.details
FROM hr_tasks t
CROSS JOIN LATERAL (
  VALUES
    ('assigned', t.status, t.created_at, jsonb_build_object('due_at', t.due_at)),
    ('acknowledged', 'acknowledged', t.acknowledged_at, jsonb_build_object('response_minutes', CASE WHEN t.acknowledged_at IS NULL THEN NULL ELSE GREATEST(0, floor(extract(epoch FROM (t.acknowledged_at - t.created_at)) / 60)) END, 'sla_minutes', 30, 'met_sla', CASE WHEN t.acknowledged_at IS NULL THEN NULL ELSE t.acknowledged_at <= t.created_at + interval '30 minutes' END)),
    ('started', 'in_progress', t.started_at, '{}'::jsonb),
    ('submitted', 'review', t.first_submitted_at, jsonb_build_object('due_at', t.due_at, 'deadline_variance_minutes', CASE WHEN t.first_submitted_at IS NULL OR t.due_at IS NULL THEN NULL ELSE floor(extract(epoch FROM (t.first_submitted_at - t.due_at)) / 60) END)),
    ('completed', 'completed', t.completed_at, '{}'::jsonb)
) AS e(event_type, to_status, event_at, details)
WHERE e.event_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM hr_task_events existing
    WHERE existing.task_id = t.id
      AND existing.event_type = e.event_type
      AND existing.event_at = e.event_at
  );

NOTIFY pgrst, 'reload schema';
