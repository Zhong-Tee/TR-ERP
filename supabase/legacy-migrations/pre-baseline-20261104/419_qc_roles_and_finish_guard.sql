-- QC is available only to superadmin, admin, production and packing_staff.
BEGIN;

UPDATE public.st_user_menus
SET has_access = false, updated_at = now()
WHERE menu_key IN ('qc', 'qc-operation', 'qc-reject', 'qc-report', 'qc-history', 'qc-settings')
  AND role NOT IN ('superadmin', 'admin', 'production', 'packing_staff');

INSERT INTO public.st_user_menus (role, menu_key, menu_name, has_access)
VALUES
  ('admin', 'qc', 'QC Operation', true),
  ('admin', 'qc-operation', 'QC · Operation', true),
  ('production', 'qc', 'QC Operation', true),
  ('production', 'qc-operation', 'QC · Operation', true),
  ('packing_staff', 'qc', 'QC Operation', true),
  ('packing_staff', 'qc-operation', 'QC · Operation', true)
ON CONFLICT (role, menu_key)
DO UPDATE SET menu_name = EXCLUDED.menu_name, has_access = EXCLUDED.has_access, updated_at = now();

DROP POLICY IF EXISTS "QC staff can manage sessions" ON public.qc_sessions;
CREATE POLICY "QC staff can manage sessions"
  ON public.qc_sessions FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ));

DROP POLICY IF EXISTS "QC staff can manage records" ON public.qc_records;
CREATE POLICY "QC staff can manage records"
  ON public.qc_records FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.us_users
    WHERE id = auth.uid() AND role IN ('superadmin', 'admin', 'production', 'packing_staff')
  ));

-- A closed partial session must not mark the Plan QC stage as complete.
CREATE OR REPLACE FUNCTION public.tr_qc_sessions_sync_qc_plan_on_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wo TEXT;
  v_start TIMESTAMPTZ;
  v_end TIMESTAMPTZ;
  v_patch JSONB;
BEGIN
  IF TG_OP <> 'UPDATE' OR OLD.end_time IS NOT NULL OR NEW.end_time IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.total_items, 0) <= 0
     OR COALESCE(NEW.pass_count, 0) <> NEW.total_items
     OR COALESCE(NEW.fail_count, 0) <> 0 THEN
    RETURN NEW;
  END IF;

  v_wo := NULLIF(trim(COALESCE(NEW.filename, '')), '');
  IF v_wo IS NULL OR v_wo NOT LIKE 'WO-%' THEN RETURN NEW; END IF;
  v_wo := NULLIF(trim(substr(v_wo, 4)), '');
  IF v_wo IS NULL THEN RETURN NEW; END IF;

  v_start := COALESCE(NEW.start_time, now());
  v_end := NEW.end_time;
  v_patch := jsonb_build_object(
    'เริ่มQC', jsonb_build_object('start_if_null', to_jsonb(v_start), 'end', to_jsonb(v_end)),
    'เสร็จแล้ว', jsonb_build_object('start_if_null', to_jsonb(v_start), 'end', to_jsonb(v_end))
  );
  PERFORM public.merge_plan_tracks_by_name(v_wo, 'QC', v_patch);
  RETURN NEW;
END;
$$;

COMMIT;
