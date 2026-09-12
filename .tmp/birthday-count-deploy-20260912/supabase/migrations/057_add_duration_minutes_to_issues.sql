-- Add duration_minutes column to or_issues for storing elapsed time when issue is closed
ALTER TABLE or_issues ADD COLUMN IF NOT EXISTS duration_minutes integer;
