BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_copy_machinery_checklist_settings(
  p_source_machine_id uuid,
  p_target_machine_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_checklist_count integer := 0;
  v_access_count integer := 0;
BEGIN
  IF NOT public.check_user_role(
    auth.uid(),
    ARRAY['superadmin', 'admin', 'production', 'technician']
  ) THEN
    RAISE EXCEPTION 'ไม่มีสิทธิ์คัดลอกการตั้งค่า Checklist เครื่องจักร';
  END IF;

  IF p_source_machine_id = p_target_machine_id THEN
    RAISE EXCEPTION 'เครื่องต้นฉบับและเครื่องปลายทางต้องไม่ใช่เครื่องเดียวกัน';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.pr_machinery_machines WHERE id = p_source_machine_id) THEN
    RAISE EXCEPTION 'ไม่พบเครื่องต้นฉบับ';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.pr_machinery_machines WHERE id = p_target_machine_id) THEN
    RAISE EXCEPTION 'ไม่พบเครื่องปลายทาง';
  END IF;

  INSERT INTO public.pr_machinery_checklist_items (
    machine_id,
    label,
    description,
    input_type,
    min_value,
    max_value,
    unit,
    requires_photo,
    is_required,
    frequency,
    sort_order,
    is_active
  )
  SELECT
    p_target_machine_id,
    source.label,
    source.description,
    source.input_type,
    source.min_value,
    source.max_value,
    source.unit,
    source.requires_photo,
    source.is_required,
    source.frequency,
    source.sort_order,
    true
  FROM public.pr_machinery_checklist_items source
  WHERE source.machine_id = p_source_machine_id
    AND source.is_active = true
    AND NOT EXISTS (
      SELECT 1
      FROM public.pr_machinery_checklist_items target
      WHERE target.machine_id = p_target_machine_id
        AND target.is_active = true
        AND target.sort_order = source.sort_order
        AND target.label = source.label
    );

  GET DIAGNOSTICS v_checklist_count = ROW_COUNT;

  INSERT INTO public.pr_machinery_inspection_machine_users (
    machine_id,
    user_id,
    created_by
  )
  SELECT
    p_target_machine_id,
    source.user_id,
    auth.uid()
  FROM public.pr_machinery_inspection_machine_users source
  WHERE source.machine_id = p_source_machine_id
  ON CONFLICT (machine_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_access_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'checklist_count', v_checklist_count,
    'access_count', v_access_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_copy_machinery_checklist_settings(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_copy_machinery_checklist_settings(uuid, uuid) TO authenticated;

COMMIT;
