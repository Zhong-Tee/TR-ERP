-- Speed up the first QC Operation queue load.
-- The client now requests only active work orders, then looks up the latest
-- plan row by work-order name and a lightweight reject badge count.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_or_work_orders_status_created_at
  ON public.or_work_orders(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_plan_jobs_name_date
  ON public.plan_jobs(name, date DESC, id);

CREATE INDEX IF NOT EXISTS idx_qc_records_rejected
  ON public.qc_records(id)
  WHERE is_rejected = true;

COMMIT;
