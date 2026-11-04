-- Plan (Production Planner) tables for TR-ERP
-- plan_settings: single row (id=1) stores departments, processes, breaks, etc.
-- plan_jobs: one row per job with order_index for dashboard ordering

CREATE TABLE IF NOT EXISTS plan_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Allow RLS; authenticated users with appropriate role can read/write (handled by app or policy)
ALTER TABLE plan_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read plan_settings"
  ON plan_settings FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert plan_settings"
  ON plan_settings FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update plan_settings"
  ON plan_settings FOR UPDATE
  USING (auth.role() = 'authenticated');

-- plan_jobs: id (text, e.g. Jxxx), date, name, cut, qty/tracks/line_assignments/manual_plan_starts/locked_plans as JSONB, order_index
CREATE TABLE IF NOT EXISTS plan_jobs (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  cut TEXT,
  qty JSONB NOT NULL DEFAULT '{}',
  tracks JSONB NOT NULL DEFAULT '{}',
  line_assignments JSONB NOT NULL DEFAULT '{}',
  manual_plan_starts JSONB NOT NULL DEFAULT '{}',
  locked_plans JSONB NOT NULL DEFAULT '{}',
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_jobs_date ON plan_jobs(date);
CREATE INDEX IF NOT EXISTS idx_plan_jobs_order_index ON plan_jobs(order_index);

ALTER TABLE plan_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read plan_jobs"
  ON plan_jobs FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert plan_jobs"
  ON plan_jobs FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update plan_jobs"
  ON plan_jobs FOR UPDATE
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can delete plan_jobs"
  ON plan_jobs FOR DELETE
  USING (auth.role() = 'authenticated');
