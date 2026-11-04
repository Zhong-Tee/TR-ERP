-- Task timing and submitted work link
ALTER TABLE hr_tasks ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE hr_tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE hr_tasks ADD COLUMN IF NOT EXISTS completion_link TEXT;

-- Backfill useful timestamps for existing records without inventing future times.
UPDATE hr_tasks SET acknowledged_at = created_at
WHERE acknowledged_at IS NULL AND status IN ('acknowledged','in_progress','review','revision','completed');
UPDATE hr_tasks SET started_at = COALESCE(acknowledged_at, created_at)
WHERE started_at IS NULL AND status IN ('in_progress','review','revision','completed');

-- Make new columns visible to PostgREST immediately after applying the migration.
NOTIFY pgrst, 'reload schema';
