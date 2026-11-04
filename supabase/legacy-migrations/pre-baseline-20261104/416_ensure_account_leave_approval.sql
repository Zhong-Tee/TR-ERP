-- Ensure the account role can approve or reject leave requests.
-- Replaces older installations of the status guard that only allowed
-- superadmin/admin/hr. This does not grant account OT or WFH approval.

CREATE OR REPLACE FUNCTION public.hr_can_approve_leave()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.us_users
    WHERE id = auth.uid()
      AND is_active IS TRUE
      AND role IN ('superadmin', 'admin', 'hr', 'account')
  );
$$;

CREATE OR REPLACE FUNCTION public.hr_leave_guard_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF public.hr_can_approve_leave() THEN
      RETURN NEW;
    END IF;

    IF NEW.status = 'cancelled'
       AND OLD.status = 'pending'
       AND OLD.employee_id = public.hr_my_employee_id() THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'ไม่มีสิทธิ์เปลี่ยนสถานะใบลา (เฉพาะ superadmin/admin/hr/account เท่านั้น)';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_hr_leave_guard_status ON public.hr_leave_requests;
CREATE TRIGGER trg_hr_leave_guard_status
  BEFORE UPDATE ON public.hr_leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.hr_leave_guard_status();

REVOKE ALL ON FUNCTION public.hr_can_approve_leave() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hr_can_approve_leave() TO authenticated;

NOTIFY pgrst, 'reload schema';
