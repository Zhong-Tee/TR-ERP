BEGIN;

ALTER TYPE pr_machinery_status ADD VALUE IF NOT EXISTS 'power_off';

COMMIT;
