-- Conditional QC skip for production: settings, mandatory-QC rules,
-- carrier pickup schedules, server-side eligibility and audit snapshots.

CREATE TABLE IF NOT EXISTS public.qc_skip_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT true,
  production_enabled boolean NOT NULL DEFAULT false,
  delay_threshold_minutes integer NOT NULL DEFAULT 30 CHECK (delay_threshold_minutes >= 0),
  backlog_work_orders_threshold integer NOT NULL DEFAULT 5 CHECK (backlog_work_orders_threshold >= 1),
  fallback_items_per_worker_hour numeric(10,2) NOT NULL DEFAULT 60 CHECK (fallback_items_per_worker_hour > 0),
  default_pack_buffer_minutes integer NOT NULL DEFAULT 45 CHECK (default_pack_buffer_minutes >= 0),
  require_production_reason boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.qc_skip_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.qc_mandatory_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL CHECK (rule_type IN ('claim', 'category', 'product')),
  rule_value text NOT NULL DEFAULT '',
  label text NOT NULL,
  reason text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (rule_type, rule_value)
);

INSERT INTO public.qc_mandatory_rules (rule_type, rule_value, label, reason)
VALUES ('claim', '', 'บิลเคลมทั้งหมด', 'บิลเคลมต้องผ่าน QC ทุกครั้ง')
ON CONFLICT (rule_type, rule_value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.qc_channel_pickup_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_code text NOT NULL REFERENCES public.channels(channel_code) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  pickup_time time NOT NULL,
  pack_buffer_minutes integer NOT NULL DEFAULT 45 CHECK (pack_buffer_minutes >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_code, day_of_week, pickup_time)
);

ALTER TABLE public.qc_skip_logs
  ADD COLUMN IF NOT EXISTS production_reason text,
  ADD COLUMN IF NOT EXISTS eligibility_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS eligibility_source text;

ALTER TABLE public.qc_skip_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qc_mandatory_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qc_channel_pickup_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qc_skip_settings_read ON public.qc_skip_settings;
CREATE POLICY qc_skip_settings_read ON public.qc_skip_settings
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS qc_skip_settings_manage ON public.qc_skip_settings;
CREATE POLICY qc_skip_settings_manage ON public.qc_skip_settings
  FOR ALL TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']))
  WITH CHECK (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']));

DROP POLICY IF EXISTS qc_mandatory_rules_read ON public.qc_mandatory_rules;
CREATE POLICY qc_mandatory_rules_read ON public.qc_mandatory_rules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS qc_mandatory_rules_manage ON public.qc_mandatory_rules;
CREATE POLICY qc_mandatory_rules_manage ON public.qc_mandatory_rules
  FOR ALL TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']))
  WITH CHECK (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']));

DROP POLICY IF EXISTS qc_channel_pickup_schedules_read ON public.qc_channel_pickup_schedules;
CREATE POLICY qc_channel_pickup_schedules_read ON public.qc_channel_pickup_schedules
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS qc_channel_pickup_schedules_manage ON public.qc_channel_pickup_schedules;
CREATE POLICY qc_channel_pickup_schedules_manage ON public.qc_channel_pickup_schedules
  FOR ALL TO authenticated
  USING (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']))
  WITH CHECK (public.check_user_role(auth.uid(), ARRAY['superadmin','admin']));

GRANT SELECT ON public.qc_skip_settings, public.qc_mandatory_rules, public.qc_channel_pickup_schedules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.qc_skip_settings, public.qc_mandatory_rules, public.qc_channel_pickup_schedules TO authenticated;

CREATE OR REPLACE FUNCTION public.rpc_qc_skip_eligibility(p_work_order_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_settings public.qc_skip_settings%ROWTYPE;
  v_now timestamptz := now();
  v_today date := timezone('Asia/Bangkok', now())::date;
  v_total integer := 0;
  v_done integer := 0;
  v_remaining integer := 0;
  v_backlog integer := 0;
  v_available integer := 0;
  v_required integer := 0;
  v_plan_end timestamptz;
  v_plan_start timestamptz;
  v_pack_start timestamptz;
  v_actual_qc_start timestamptz;
  v_pickup_deadline timestamptz;
  v_deadline timestamptz;
  v_predicted_finish timestamptz;
  v_capacity numeric := 0;
  v_minutes_available numeric := 0;
  v_is_mandatory boolean := false;
  v_mandatory_reasons jsonb := '[]'::jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_is_urgent boolean := false;
  v_plan_date date;
  v_plan_job_id text;
  v_qc_start_seconds numeric;
  v_qc_end_seconds numeric;
  v_pack_start_seconds numeric;
BEGIN
  SELECT role INTO v_role FROM public.us_users WHERE id = auth.uid();
  IF v_role IS NULL THEN RAISE EXCEPTION 'ไม่พบสิทธิ์ผู้ใช้งาน'; END IF;

  SELECT * INTO v_settings FROM public.qc_skip_settings WHERE id = 1;

  SELECT COALESCE(sum(GREATEST(COALESCE(oi.quantity, 0), 0)), 0)::integer
  INTO v_total
  FROM public.or_orders o
  JOIN public.or_order_items oi ON oi.order_id = o.id
  WHERE o.work_order_name = p_work_order_name
    AND COALESCE(o.status, '') NOT IN ('ยกเลิก', 'ยกเลิกคำสั่งซื้อ');

  SELECT count(DISTINCT r.item_uid)::integer INTO v_done
  FROM public.qc_records r
  WHERE r.item_uid IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.or_orders o
      WHERE o.work_order_name = p_work_order_name
        AND r.bill_no = o.bill_no
    )
    AND r.status IN ('pass', 'fail');
  v_remaining := GREATEST(v_total - v_done, 0);

  IF EXISTS (
    SELECT 1 FROM public.qc_mandatory_rules r
    JOIN public.or_orders o ON o.work_order_name = p_work_order_name
    WHERE r.is_active AND r.rule_type = 'claim' AND COALESCE(o.claim_type, '') <> ''
  ) THEN
    v_is_mandatory := true;
    v_mandatory_reasons := v_mandatory_reasons || jsonb_build_array('บิลเคลม');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.qc_mandatory_rules r
    JOIN public.or_orders o ON o.work_order_name = p_work_order_name
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE r.is_active
      AND ((r.rule_type = 'category' AND r.rule_value = COALESCE(p.product_category, ''))
        OR (r.rule_type = 'product' AND r.rule_value = p.id::text))
  ) THEN
    v_is_mandatory := true;
    SELECT COALESCE(jsonb_agg(DISTINCT r.label), '[]'::jsonb)
    INTO v_mandatory_reasons
    FROM public.qc_mandatory_rules r
    JOIN public.or_orders o ON o.work_order_name = p_work_order_name
    JOIN public.or_order_items oi ON oi.order_id = o.id
    JOIN public.pr_products p ON p.id = oi.product_id
    WHERE r.is_active
      AND ((r.rule_type = 'category' AND r.rule_value = COALESCE(p.product_category, ''))
        OR (r.rule_type = 'product' AND r.rule_value = p.id::text));
  END IF;

  SELECT pj.id, pj.date,
         NULLIF(pj.locked_plans->'QC'->>'start', '')::numeric,
         NULLIF(pj.locked_plans->'QC'->>'end', '')::numeric,
         NULLIF(pj.locked_plans->'PACK'->>'start', '')::numeric
  INTO v_plan_job_id, v_plan_date, v_qc_start_seconds, v_qc_end_seconds, v_pack_start_seconds
  FROM public.plan_jobs pj
  WHERE pj.name = p_work_order_name
  ORDER BY pj.date DESC, pj.order_index DESC
  LIMIT 1;

  IF v_plan_date IS NOT NULL AND v_qc_start_seconds IS NOT NULL THEN
    v_plan_start := (v_plan_date::timestamp + make_interval(secs => v_qc_start_seconds)) AT TIME ZONE 'Asia/Bangkok';
  END IF;
  IF v_plan_date IS NOT NULL AND v_qc_end_seconds IS NOT NULL THEN
    v_plan_end := (v_plan_date::timestamp + make_interval(secs => v_qc_end_seconds)) AT TIME ZONE 'Asia/Bangkok';
  END IF;
  IF v_plan_date IS NOT NULL AND v_pack_start_seconds IS NOT NULL THEN
    v_pack_start := (v_plan_date::timestamp + make_interval(secs => v_pack_start_seconds)) AT TIME ZONE 'Asia/Bangkok';
  END IF;

  IF v_plan_job_id IS NOT NULL THEN
    SELECT min(NULLIF(step.value->>'start', '')::timestamptz)
    INTO v_actual_qc_start
    FROM public.plan_jobs pj
    CROSS JOIN LATERAL jsonb_each(COALESCE(pj.tracks->'QC', '{}'::jsonb)) step
    WHERE pj.id = v_plan_job_id;

    v_plan_start := COALESCE(v_plan_start, (
      SELECT min(a.planned_start) FROM public.plan_worker_assignments a
      WHERE a.plan_job_id = v_plan_job_id AND a.department_name = 'QC' AND a.status <> 'cancelled'
    ));
    v_plan_end := COALESCE(v_plan_end, (
      SELECT max(a.planned_end) FROM public.plan_worker_assignments a
      WHERE a.plan_job_id = v_plan_job_id AND a.department_name = 'QC' AND a.status <> 'cancelled'
    ));
    v_pack_start := COALESCE(v_pack_start, (
      SELECT min(a.planned_start) FROM public.plan_worker_assignments a
      WHERE a.plan_job_id = v_plan_job_id AND a.department_name = 'PACK' AND a.status <> 'cancelled'
    ));
  END IF;

  SELECT min((v_today::timestamp + s.pickup_time - make_interval(mins => s.pack_buffer_minutes)) AT TIME ZONE 'Asia/Bangkok')
  INTO v_pickup_deadline
  FROM public.qc_channel_pickup_schedules s
  WHERE s.is_active
    AND s.day_of_week = extract(dow FROM v_today)::integer
    AND EXISTS (
      SELECT 1 FROM public.or_orders o
      WHERE o.work_order_name = p_work_order_name AND o.channel_code = s.channel_code
    );

  SELECT count(DISTINCT pj.name)::integer INTO v_backlog
  FROM public.plan_jobs pj
  WHERE pj.date = v_today
    AND COALESCE(pj.is_production_voided, false) = false
    AND COALESCE(pj.tracks->'QC'->'เสร็จแล้ว'->>'end', '') = '';

  SELECT count(DISTINCT e.id)::integer INTO v_available
  FROM public.hr_employees e
  JOIN public.plan_employee_skills sk ON sk.employee_id = e.id
  WHERE e.employment_status IN ('active', 'probation')
    AND sk.department_name = 'QC'
    AND sk.qualification_status <> 'blocked'
    AND (sk.valid_until IS NULL OR sk.valid_until >= v_today)
    AND EXISTS (
      SELECT 1 FROM public.hr_time_entries te
      WHERE te.employee_id = e.id AND te.work_date = v_today AND te.entry_type = 'clock_in'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.hr_leave_requests lr
      WHERE lr.employee_id = e.id AND lr.status = 'approved'
        AND v_today BETWEEN lr.start_date AND lr.end_date
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.plan_worker_assignments a
      WHERE a.employee_id = e.id
        AND a.status NOT IN ('cancelled', 'completed')
        AND a.department_name <> 'QC'
        AND v_now >= a.planned_start AND v_now < a.planned_end
    );

  SELECT COALESCE(max(required_workers), 0)::integer INTO v_required
  FROM public.plan_operation_requirements
  WHERE department_name = 'QC';

  v_deadline := LEAST(
    COALESCE(v_plan_end, 'infinity'::timestamptz),
    COALESCE(v_pack_start, 'infinity'::timestamptz),
    COALESCE(v_pickup_deadline, 'infinity'::timestamptz)
  );
  IF v_deadline = 'infinity'::timestamptz THEN v_deadline := v_now + interval '8 hours'; END IF;

  IF v_available > 0 THEN
    v_predicted_finish := v_now + make_interval(secs => (v_remaining / (v_available * v_settings.fallback_items_per_worker_hour) * 3600)::integer);
  ELSE
    v_predicted_finish := v_now + interval '24 hours';
  END IF;
  v_minutes_available := GREATEST(extract(epoch FROM (v_deadline - v_now)) / 60, 0);
  v_capacity := v_available * v_settings.fallback_items_per_worker_hour * v_minutes_available / 60;

  IF v_plan_end IS NOT NULL AND v_predicted_finish > v_plan_end + make_interval(mins => v_settings.delay_threshold_minutes) THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('คาดว่า QC ช้ากว่าแผน');
  END IF;
  IF v_backlog >= v_settings.backlog_work_orders_threshold THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('ใบงานรอ QC เกินเกณฑ์');
  END IF;
  IF v_remaining > v_capacity THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('จำนวนชิ้นเกินกำลังคนก่อน deadline');
  END IF;
  IF v_pack_start IS NOT NULL AND v_predicted_finish > v_pack_start THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('คาดว่าจะกระทบเวลาเริ่ม PACK');
  END IF;
  IF v_plan_start IS NOT NULL AND v_now > v_plan_start AND v_actual_qc_start IS NULL THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('งานเข้า QC ช้ากว่าแผน');
  END IF;
  IF v_pickup_deadline IS NOT NULL AND v_predicted_finish > v_pickup_deadline THEN
    v_is_urgent := true; v_reasons := v_reasons || jsonb_build_array('คาดว่าไม่ทันรอบขนส่ง');
  END IF;

  RETURN jsonb_build_object(
    'eligible', CASE
      WHEN v_role IN ('superadmin', 'admin') THEN true
      ELSE v_settings.enabled AND v_settings.production_enabled AND v_role = 'production' AND v_is_urgent AND NOT v_is_mandatory
    END,
    'role', v_role,
    'urgent', v_is_urgent,
    'mandatory_qc', v_is_mandatory,
    'mandatory_reasons', v_mandatory_reasons,
    'reasons', v_reasons,
    'remaining_items', v_remaining,
    'backlog_work_orders', v_backlog,
    'available_qc_workers', v_available,
    'required_qc_workers', v_required,
    'capacity_before_deadline', round(v_capacity, 1),
    'predicted_finish', v_predicted_finish,
    'plan_qc_start', v_plan_start,
    'plan_qc_end', v_plan_end,
    'pack_start', v_pack_start,
    'pickup_deadline', v_pickup_deadline,
    'evaluated_at', v_now
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_qc_skip_eligibility(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_qc_skip_eligibility(text) TO authenticated;

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('production', 'qc', 'QC Operation', true),
  ('production', 'qc-operation', 'QC · Operation', true),
  ('production', 'qc-reject', 'QC · Reject', false),
  ('production', 'qc-report', 'QC · Reports', false),
  ('production', 'qc-history', 'QC · History', false),
  ('production', 'qc-settings', 'QC · Settings', false)
ON CONFLICT (role, menu_key)
DO UPDATE SET menu_name = EXCLUDED.menu_name, has_access = EXCLUDED.has_access;
