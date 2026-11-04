-- Add fail_type to settings_reasons (Man/Machine/Material/Method)
ALTER TABLE settings_reasons
  ADD COLUMN IF NOT EXISTS fail_type TEXT DEFAULT 'Man';

UPDATE settings_reasons
  SET fail_type = 'Man'
  WHERE fail_type IS NULL;

COMMENT ON COLUMN settings_reasons.fail_type IS 'Fail type: Man, Machine, Material, Method';
