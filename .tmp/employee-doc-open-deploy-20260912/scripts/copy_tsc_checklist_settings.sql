-- คัดลอกการตั้งค่า Checklist และสิทธิ์ผู้ตรวจจากเครื่อง TSC ต้นแบบ
-- ไปยังเครื่องประเภท TSC เครื่องอื่นทั้งหมด
--
-- วิธีใช้
-- 1) แก้ชื่อเครื่องต้นแบบใน v_source_machine_name ให้ตรงกับข้อมูลจริง
-- 2) รันส่วน PREVIEW ก่อน เพื่อตรวจสอบเครื่องต้นแบบและเครื่องปลายทาง
-- 3) เมื่อข้อมูลถูกต้อง ให้รันตั้งแต่ BEGIN ถึง COMMIT
--
-- หมายเหตุ
-- - รายการ Checklist เดิมของเครื่องปลายทางจะถูก "ปิดใช้งาน" ไม่ได้ลบ
--   เพื่อรักษาประวัติผลตรวจเดิมที่อ้างอิง Checklist เหล่านั้น
-- - สิทธิ์ผู้ตรวจของเครื่องปลายทางจะถูกแทนที่ให้เหมือนเครื่องต้นแบบ
-- - ไม่คัดลอกประวัติการตรวจหรือผลการตรวจ

-- ================================================================
-- PREVIEW: แก้ชื่อเครื่องต้นแบบตรงนี้ แล้วรันเฉพาะ SELECT ชุดนี้ก่อน
-- ================================================================
WITH settings AS (
  SELECT
    'เครื่องปริ้น TSC #12'::text AS source_machine_name,
    'TSC'::text AS target_machine_type
)
SELECT
  machine.id,
  machine.name,
  machine.machine_type,
  CASE
    WHEN lower(btrim(machine.name)) = lower(btrim(settings.source_machine_name))
      THEN 'SOURCE'
    ELSE 'TARGET'
  END AS copy_role,
  (
    SELECT count(*)
    FROM public.pr_machinery_checklist_items checklist
    WHERE checklist.machine_id = machine.id
      AND checklist.is_active = true
  ) AS active_checklist_count,
  (
    SELECT count(*)
    FROM public.pr_machinery_inspection_machine_users access_row
    WHERE access_row.machine_id = machine.id
  ) AS inspector_count
FROM public.pr_machinery_machines machine
CROSS JOIN settings
WHERE upper(btrim(coalesce(machine.machine_type, '')))
    = upper(btrim(settings.target_machine_type))
ORDER BY copy_role, machine.sort_order, machine.name;

-- ================================================================
-- COPY: ต้องใช้ชื่อเครื่องต้นแบบเดียวกับส่วน PREVIEW ด้านบน
-- ================================================================
BEGIN;

DO $$
DECLARE
  -- แก้ชื่อเครื่องต้นแบบตรงนี้ก่อนรัน
  v_source_machine_name text := 'เครื่องปริ้น TSC #12';
  v_target_machine_type text := 'TSC';

  v_source_machine_id uuid;
  v_source_match_count integer := 0;
  v_source_checklist_count integer := 0;
  v_target_count integer := 0;
  v_deactivated_count integer := 0;
  v_inserted_checklist_count integer := 0;
  v_removed_access_count integer := 0;
  v_inserted_access_count integer := 0;
BEGIN
  SELECT count(*), min(machine.id::text)::uuid
  INTO v_source_match_count, v_source_machine_id
  FROM public.pr_machinery_machines machine
  WHERE lower(btrim(machine.name)) = lower(btrim(v_source_machine_name))
    AND upper(btrim(coalesce(machine.machine_type, '')))
      = upper(btrim(v_target_machine_type));

  IF v_source_match_count = 0 THEN
    RAISE EXCEPTION
      'ไม่พบเครื่องต้นแบบชื่อ "%" ที่มีประเภท "%"',
      v_source_machine_name,
      v_target_machine_type;
  END IF;

  IF v_source_match_count > 1 THEN
    RAISE EXCEPTION
      'พบเครื่องต้นแบบชื่อ "%" ซ้ำ % รายการ กรุณาแก้ชื่อให้ไม่ซ้ำก่อนรัน',
      v_source_machine_name,
      v_source_match_count;
  END IF;

  SELECT count(*)
  INTO v_source_checklist_count
  FROM public.pr_machinery_checklist_items checklist
  WHERE checklist.machine_id = v_source_machine_id
    AND checklist.is_active = true;

  IF v_source_checklist_count = 0 THEN
    RAISE EXCEPTION
      'เครื่องต้นแบบ "%" ไม่มี Checklist ที่เปิดใช้งาน จึงยกเลิกการคัดลอก',
      v_source_machine_name;
  END IF;

  SELECT count(*)
  INTO v_target_count
  FROM public.pr_machinery_machines machine
  WHERE upper(btrim(coalesce(machine.machine_type, '')))
      = upper(btrim(v_target_machine_type))
    AND machine.id <> v_source_machine_id;

  IF v_target_count = 0 THEN
    RAISE EXCEPTION
      'ไม่พบเครื่องปลายทางประเภท "%" นอกเหนือจากเครื่องต้นแบบ',
      v_target_machine_type;
  END IF;

  -- ปิด Checklist เดิมแทนการลบ เพื่อรักษาประวัติผลตรวจเดิม
  UPDATE public.pr_machinery_checklist_items checklist
  SET
    is_active = false,
    updated_at = now()
  FROM public.pr_machinery_machines target
  WHERE checklist.machine_id = target.id
    AND target.id <> v_source_machine_id
    AND upper(btrim(coalesce(target.machine_type, '')))
      = upper(btrim(v_target_machine_type))
    AND checklist.is_active = true;

  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;

  -- สร้าง Checklist ชุดใหม่ให้เครื่อง TSC ทุกเครื่องเหมือนต้นแบบ
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
    target.id,
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
  FROM public.pr_machinery_machines target
  CROSS JOIN public.pr_machinery_checklist_items source
  WHERE target.id <> v_source_machine_id
    AND upper(btrim(coalesce(target.machine_type, '')))
      = upper(btrim(v_target_machine_type))
    AND source.machine_id = v_source_machine_id
    AND source.is_active = true;

  GET DIAGNOSTICS v_inserted_checklist_count = ROW_COUNT;

  -- แทนที่สิทธิ์ผู้ตรวจของเครื่องปลายทางให้เหมือนเครื่องต้นแบบ
  DELETE FROM public.pr_machinery_inspection_machine_users access_row
  USING public.pr_machinery_machines target
  WHERE access_row.machine_id = target.id
    AND target.id <> v_source_machine_id
    AND upper(btrim(coalesce(target.machine_type, '')))
      = upper(btrim(v_target_machine_type));

  GET DIAGNOSTICS v_removed_access_count = ROW_COUNT;

  INSERT INTO public.pr_machinery_inspection_machine_users (
    machine_id,
    user_id,
    created_by
  )
  SELECT
    target.id,
    source_access.user_id,
    coalesce(auth.uid(), source_access.created_by)
  FROM public.pr_machinery_machines target
  CROSS JOIN public.pr_machinery_inspection_machine_users source_access
  WHERE target.id <> v_source_machine_id
    AND upper(btrim(coalesce(target.machine_type, '')))
      = upper(btrim(v_target_machine_type))
    AND source_access.machine_id = v_source_machine_id
  ON CONFLICT (machine_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted_access_count = ROW_COUNT;

  RAISE NOTICE 'คัดลอกจากเครื่องต้นแบบ: % (%)',
    v_source_machine_name,
    v_source_machine_id;
  RAISE NOTICE 'เครื่องปลายทางทั้งหมด: % เครื่อง', v_target_count;
  RAISE NOTICE 'Checklist ต้นแบบ: % รายการ', v_source_checklist_count;
  RAISE NOTICE 'ปิด Checklist เดิม: % รายการ', v_deactivated_count;
  RAISE NOTICE 'เพิ่ม Checklist ใหม่: % รายการ', v_inserted_checklist_count;
  RAISE NOTICE 'ลบสิทธิ์ผู้ตรวจเดิม: % รายการ', v_removed_access_count;
  RAISE NOTICE 'เพิ่มสิทธิ์ผู้ตรวจใหม่: % รายการ', v_inserted_access_count;
END;
$$;

COMMIT;

-- ตรวจสอบผลหลังคัดลอก
SELECT
  machine.name,
  count(DISTINCT checklist.id) FILTER (WHERE checklist.is_active = true) AS active_checklist_count,
  count(DISTINCT access_row.user_id) AS inspector_count
FROM public.pr_machinery_machines machine
LEFT JOIN public.pr_machinery_checklist_items checklist
  ON checklist.machine_id = machine.id
LEFT JOIN public.pr_machinery_inspection_machine_users access_row
  ON access_row.machine_id = machine.id
WHERE upper(btrim(coalesce(machine.machine_type, ''))) = 'TSC'
GROUP BY machine.id, machine.name, machine.sort_order
ORDER BY machine.sort_order, machine.name;
