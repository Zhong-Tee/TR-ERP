-- Keep the machine snapshot and its status timeline consistent. Re-selecting
-- the current status is a no-op, preventing duplicate/open status events.
BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_change_machinery_status(
  p_machine_id uuid,
  p_status public.pr_machinery_status,
  p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status public.pr_machinery_status;
  v_changed_at timestamptz := clock_timestamp();
BEGIN
  IF NOT public.check_user_role(
    auth.uid(),
    ARRAY['superadmin', 'admin', 'production', 'production_mb', 'manager', 'technician']
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนสถานะเครื่องจักร';
  END IF;

  SELECT machine.current_status
    INTO v_current_status
  FROM public.pr_machinery_machines AS machine
  WHERE machine.id = p_machine_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ไม่พบเครื่องจักร';
  END IF;

  IF v_current_status = p_status THEN
    RETURN false;
  END IF;

  UPDATE public.pr_machinery_status_events
  SET ended_at = v_changed_at
  WHERE machine_id = p_machine_id
    AND ended_at IS NULL;

  UPDATE public.pr_machinery_machines
  SET current_status = p_status,
      status_changed_at = v_changed_at
  WHERE id = p_machine_id;

  INSERT INTO public.pr_machinery_status_events (
    machine_id, status, started_at, ended_at, note, created_by
  ) VALUES (
    p_machine_id, p_status, v_changed_at, NULL, p_note, auth.uid()
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_change_machinery_status(uuid, public.pr_machinery_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_change_machinery_status(uuid, public.pr_machinery_status, text) TO authenticated;

COMMIT;
