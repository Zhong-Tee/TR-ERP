-- WFH decisions and cancellations use the same approver roles.
ALTER TABLE public.hr_wfh_requests
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS approved_by_name text,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS cancelled_by_name text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

-- Preserve names on older decisions where an employee record still exists.
UPDATE public.hr_wfh_requests r
SET approved_by_name = concat_ws(' ', e.first_name, e.last_name),
    approved_by_user_id = e.user_id
FROM public.hr_employees e
WHERE e.id = r.approved_by AND r.approved_by_name IS NULL;

DROP POLICY IF EXISTS hr_wfh_requests_update ON public.hr_wfh_requests;
CREATE POLICY hr_wfh_requests_update ON public.hr_wfh_requests
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin')))
WITH CHECK (EXISTS (SELECT 1 FROM public.us_users WHERE id = auth.uid() AND role IN ('superadmin', 'admin')));

CREATE OR REPLACE FUNCTION public.hr_guard_wfh_decision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_employee uuid;
  v_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.approved_by_user_id IS NOT NULL OR NEW.approved_by_name IS NOT NULL
       OR NEW.cancelled_by_user_id IS NOT NULL OR NEW.cancelled_by_name IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'คำขอใหม่ต้องอยู่ในสถานะรออนุมัติ';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM us_users WHERE id = v_actor AND role IN ('superadmin', 'admin')) THEN
    RAISE EXCEPTION 'เฉพาะ superadmin และ admin เท่านั้นที่อนุมัติหรือยกเลิก WFH ได้';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','approved_by','approved_at','approved_by_user_id','approved_by_name',
      'reject_reason','cancelled_by_user_id','cancelled_by_name','cancelled_at','cancel_reason','updated_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','approved_by','approved_at','approved_by_user_id','approved_by_name',
      'reject_reason','cancelled_by_user_id','cancelled_by_name','cancelled_at','cancel_reason','updated_at']) THEN
    RAISE EXCEPTION 'ไม่สามารถแก้ไขรายละเอียดคำขอเดิม กรุณายกเลิกและส่งคำขอใหม่';
  END IF;
  SELECT e.id, COALESCE(NULLIF(trim(concat_ws(' ', e.first_name, e.last_name)), ''), u.username, v_actor::text)
    INTO v_employee, v_name FROM us_users u
    LEFT JOIN hr_employees e ON e.user_id = u.id
    WHERE u.id = v_actor LIMIT 1;

  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    IF NEW.status = 'rejected' AND NULLIF(trim(NEW.reject_reason), '') IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ไม่อนุมัติ';
    END IF;
    NEW.approved_by := v_employee;
    NEW.approved_at := now();
    NEW.approved_by_user_id := v_actor;
    NEW.approved_by_name := v_name;
    NEW.reject_reason := CASE WHEN NEW.status = 'rejected' THEN trim(NEW.reject_reason) ELSE NULL END;
    NEW.cancelled_by_user_id := NULL;
    NEW.cancelled_by_name := NULL;
    NEW.cancelled_at := NULL;
    NEW.cancel_reason := NULL;
  ELSIF OLD.status = 'approved' AND NEW.status = 'cancelled' THEN
    IF OLD.start_date <= (now() AT TIME ZONE 'Asia/Bangkok')::date THEN
      RAISE EXCEPTION 'ยกเลิกได้เฉพาะคำขอที่ยังไม่ถึงวันเริ่มต้น';
    END IF;
    IF EXISTS (SELECT 1 FROM hr_time_entries WHERE employee_id = OLD.employee_id
      AND (wfh_request_id = OLD.id OR work_date BETWEEN OLD.start_date AND OLD.end_date)) THEN
      RAISE EXCEPTION 'ไม่สามารถยกเลิกได้ เนื่องจากมีการบันทึกเวลาทำงานแล้ว';
    END IF;
    IF NULLIF(trim(NEW.cancel_reason), '') IS NULL THEN
      RAISE EXCEPTION 'กรุณาระบุเหตุผลที่ยกเลิก';
    END IF;
    NEW.approved_by := OLD.approved_by;
    NEW.approved_at := OLD.approved_at;
    NEW.approved_by_user_id := OLD.approved_by_user_id;
    NEW.approved_by_name := OLD.approved_by_name;
    NEW.reject_reason := OLD.reject_reason;
    NEW.cancelled_by_user_id := v_actor;
    NEW.cancelled_by_name := v_name;
    NEW.cancelled_at := now();
    NEW.cancel_reason := trim(NEW.cancel_reason);
  ELSE
    RAISE EXCEPTION 'สถานะคำขอเปลี่ยนแล้ว หรือไม่สามารถดำเนินการจากสถานะนี้ได้';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_hr_guard_wfh_decision BEFORE INSERT OR UPDATE ON public.hr_wfh_requests
FOR EACH ROW EXECUTE FUNCTION public.hr_guard_wfh_decision();

CREATE OR REPLACE FUNCTION public.hr_wfh_cancel_notify()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'cancelled' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (NEW.employee_id, 'wfh_result', 'คำขอ WFH ถูกยกเลิกแล้ว',
      'WFH วันที่ ' || NEW.start_date::text || ' ถึง ' || NEW.end_date::text ||
      ' ถูกยกเลิกโดย ' || NEW.cancelled_by_name || ' เหตุผล: ' || NEW.cancel_reason ||
      ' หากต้องการวันใหม่ กรุณาส่งคำขอและรออนุมัติอีกครั้ง', '/employee?notif=result', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_hr_wfh_cancel_notify AFTER UPDATE OF status ON public.hr_wfh_requests
FOR EACH ROW EXECUTE FUNCTION public.hr_wfh_cancel_notify();

-- Pending approval notifications go only to the roles that can act.
CREATE OR REPLACE FUNCTION hr_wfh_notify() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    SELECT e.id, 'wfh_approval_pending', 'มีคำขอ WFH รออนุมัติ',
      'พนักงานส่งคำขอ WFH วันที่ ' || NEW.start_date::text || ' ถึง ' || NEW.end_date::text,
      '/employee?notif=pending', NEW.id
    FROM hr_employees e
    JOIN us_users u ON u.id = e.user_id
    WHERE u.role IN ('superadmin', 'admin');
  ELSIF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected') THEN
    INSERT INTO hr_notifications (employee_id, type, title, message, link, related_id)
    VALUES (
      NEW.employee_id,
      'wfh_result',
      CASE WHEN NEW.status = 'approved' THEN 'คำขอ WFH ได้รับการอนุมัติ' ELSE 'คำขอ WFH ถูกปฏิเสธ' END,
      CASE WHEN NEW.status = 'approved' THEN 'คุณสามารถลงเวลาแบบ WFH ในช่วงวันที่อนุมัติได้'
           ELSE COALESCE('เหตุผล: ' || NEW.reject_reason, 'คำขอ WFH ไม่ได้รับการอนุมัติ') END,
      '/employee?notif=result', NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

