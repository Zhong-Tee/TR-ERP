-- Correct the approved hourly sick leave that was calculated before the
-- employee's lunch break was changed from 12:00-13:00 to 13:00-14:00.
--
-- Requested range: 2026-09-10 13:00-18:30
-- Working time after excluding 13:00-14:00: 4 hours 30 minutes
-- Workday: 09:30-18:30 excluding one hour lunch = 8 hours
-- Leave fraction: 4.5 / 8 = 0.5625, rounded by the application to 0.56 day
DO $$
DECLARE
  v_leave_ids UUID[];
  v_match_count INTEGER;
BEGIN
  SELECT ARRAY_AGG(request.id), COUNT(*)::INTEGER
  INTO v_leave_ids, v_match_count
  FROM public.hr_leave_requests request
  JOIN public.hr_employees employee
    ON employee.id = request.employee_id
  JOIN public.hr_leave_types leave_type
    ON leave_type.id = request.leave_type_id
  WHERE BTRIM(employee.first_name) = 'นนทวัฒน์'
    AND BTRIM(employee.last_name) = 'มาลี'
    AND BTRIM(COALESCE(employee.nickname, '')) = 'โจ'
    AND BTRIM(leave_type.name) = 'ลาป่วย'
    AND request.leave_mode = 'hourly'
    AND request.start_date = DATE '2026-09-10'
    AND request.end_date = DATE '2026-09-10'
    AND request.start_time = TIME '13:00'
    AND request.end_time = TIME '18:30'
    AND request.status = 'approved';

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION
      'Migration 531 expected exactly one approved hourly leave for นนทวัฒน์ มาลี (โจ), but found %',
      v_match_count;
  END IF;

  UPDATE public.hr_leave_requests
  SET total_hours = 4.50,
      total_days = 0.56
  WHERE id = v_leave_ids[1];
END;
$$;
