-- 167: Auto-promote system_complete pending rows to correct
-- Ensures stock deduction is always triggered for non-pick/system-complete lines.

CREATE OR REPLACE FUNCTION trg_wms_promote_system_complete_pending()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.fulfillment_mode = 'system_complete'
     AND NEW.status = 'pending'
  THEN
    UPDATE wms_orders
    SET status = 'correct'
    WHERE id = NEW.id
      AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wms_promote_system_complete_pending ON wms_orders;
CREATE TRIGGER trg_wms_promote_system_complete_pending
AFTER INSERT OR UPDATE OF fulfillment_mode, status
ON wms_orders
FOR EACH ROW
EXECUTE FUNCTION trg_wms_promote_system_complete_pending();

-- Backfill any existing stuck rows once on migration run.
UPDATE wms_orders
SET status = 'correct'
WHERE fulfillment_mode = 'system_complete'
  AND status = 'pending';
