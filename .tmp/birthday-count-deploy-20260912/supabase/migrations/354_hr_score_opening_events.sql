-- อนุญาตเหตุการณ์ยอดยกมาและเหตุการณ์ลงเวลาจริงชนิดเดียวกันในวันเริ่มระบบ
DROP INDEX IF EXISTS public.uq_hr_score_events_auto;
CREATE UNIQUE INDEX uq_hr_score_events_auto
  ON public.hr_score_events (employee_id, event_date, event_code, COALESCE(ref_table, ''))
  WHERE source = 'auto';
